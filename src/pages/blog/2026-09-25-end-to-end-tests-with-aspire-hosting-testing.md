---
templateKey: 'blog-post'
title: 'End-to-end tests of a distributed .NET app with Aspire.Hosting.Testing'
date: 2026-09-25T09:00:00.000Z
author: Jimmy Boinembalome
authorimage: /img/jimmy.jpg
category: C#
categorycolor: bg-purple-100 text-purple-800
featuredpost: true
featuredimage: /img/end-to-end-tests-with-aspire-hosting-testing.jpg
description: >-
  Learn how to run Gherkin scenarios against your real Aspire graph, gateway, identity server and RabbitMQ included, in a couple of minutes and without a browser.
tags:
  - Development
  - C#
  - ASP.NET Core
  - Aspire
  - Testing
  - Reqnroll
---

Our integration tests are fast and useful, but they lie a little. `WebApplicationFactory` hosts the API on its own, the current user is a mock, and the message bus runs on in-process queues. So they never see the gateway exchanging its session cookie for an access token, the API accepting that token as its own audience, or an event actually crossing RabbitMQ before a consumer writes a row.

Those are exactly where a distributed application breaks. And if an Aspire AppHost already describes the system, we can start that very graph from a test project and talk to it over HTTP.

In this article, we will build an end-to-end suite with **Aspire.Hosting.Testing** and **Reqnroll**: real PostgreSQL, real RabbitMQ, a real identity host, a real API behind a real gateway, nothing mocked, and a sign-in through the real OpenID Connect flow. Without a browser, it runs in a couple of minutes.


## Prerequisites
Before to start you will need:
- The [.NET 10 SDK](https://dotnet.microsoft.com/download/dotnet/10.0).
- Docker, for the containers of the graph.
- An existing Aspire AppHost that describes your system.

> **_Note:_**  If your AppHost also starts npm apps, its build may need Node and an installed front-end workspace, even if the tests never use them. Worth knowing before CI surprises you. 😉


## The test projects
Let's split the suite in two: a **fixtures** project that starts the graph and signs in, and an **API** project with the Gherkin and the steps. The fixtures project references the AppHost itself:

```xml
<ItemGroup>
  <PackageReference Include="Aspire.Hosting.Keycloak" />
  <PackageReference Include="Aspire.Hosting.Testing" />
  <PackageReference Include="xunit.v3.extensibility.core" />
</ItemGroup>

<ItemGroup>
  <ProjectReference Include="../../back/Blouppy.Aspire.AppHost/Blouppy.Aspire.AppHost.csproj" />
</ItemGroup>
```

And the scenarios project uses **Reqnroll** (the open-source continuation of SpecFlow) on top of xUnit v3:

```xml
<ItemGroup>
  <PackageReference Include="FluentAssertions" />
  <PackageReference Include="Microsoft.NET.Test.Sdk" />
  <PackageReference Include="Reqnroll.xunit.v3" />
  <PackageReference Include="xunit.v3" />
</ItemGroup>
```

The project reference to the AppHost generates the `Projects.Blouppy_Aspire_AppHost` type the testing builder starts, and `Reqnroll.xunit.v3` turns each `.feature` file into xUnit tests.


## Build the graph from the real AppHost
The important decision is to **not** describe the system a second time. The AppHost's `Program.cs` already says what the system is; the suite reads it instead of restating it.

Let's create the fixture:

```csharp
public async ValueTask InitializeAsync()
{
    var builder = await DistributedApplicationTestingBuilder.CreateAsync<Projects.Blouppy_Aspire_AppHost>();

    // The identity host registers the gateway's client with RedirectUris =
    // {GatewayUrl}/signin-oidc: a randomized port would point at nobody.
    builder.Configuration["DcpPublisher:RandomizePorts"] = "false";

    foreach (var (key, value) in AppHostParameters.Defaults)
    {
        builder.Configuration[$"Parameters:{key}"] = Environment.GetEnvironmentVariable($"Parameters__{key}") ?? value;
    }

    foreach (var container in builder.Resources.OfType<ContainerResource>().ToList())
    {
        builder.CreateResourceBuilder(container).WithLifetime(ContainerLifetime.Session);
    }

    foreach (var project in builder.Resources.OfType<ProjectResource>().ToList())
    {
        builder.CreateResourceBuilder(project)
            .WithEnvironment("DOTNET_ENVIRONMENT", "Development")
            .WithEnvironment("ASPNETCORE_ENVIRONMENT", "Development");
    }

    _app = await builder.BuildAsync();
    await _app.StartAsync();

    using var startup = new CancellationTokenSource(StartupCeiling);
    await new GraphReadiness(_app).WaitAsync(startup.Token);

    Gateway = _app.GetEndpoint("blouppy-gateway", "https");
}
```

This is a trimmed version of `BlouppyGraph` in `e2e/Blouppy.E2E.Fixtures/BlouppyGraph.cs`. Each tweak has a reason:
- **Fixed ports.** The testing builder randomizes ports by default. Here every host reads the others' URLs from configuration, and the gateway's redirect URI is registered at the identity host, so `DcpPublisher:RandomizePorts` is turned off and the graph keeps the ports the AppHost declares.
- **Parameters.** The AppHost's secret parameters normally come from user secrets. `AppHostParameters.Defaults` gives throwaway values instead, and `Parameters__<name>` can still override one.
- **Session containers.** In development, PostgreSQL, RabbitMQ and the others live in persistent containers on named volumes. A test run reusing them would sign in with whatever password first created the volume. `ContainerLifetime.Session` gives the run containers of its own, which end with it. The real fixture also swaps each named volume for an anonymous one at the same path.
- **Development, pinned.** The sample data every scenario signs in with is only seeded in Development, so the environment is set on each project rather than inherited.

> **_Note:_**  The real fixture also adds a Keycloak container with `AddKeycloak`, so single sign-on scenarios run against a real OpenID Connect provider. Adding resources on top of the AppHost is fine.


## Wait for the graph, not for a clock
A `Task.Delay` is either too short on CI or too long everywhere else. Aspire already knows the state of each resource, so let's ask it:

```csharp
var finished = await notifications.WaitForResourceAsync(
    Migrations,
    resource => resource.Snapshot.State?.Text is { } state && FinishedStates.Contains(state),
    cancellationToken);

if (finished.Snapshot.State?.Text == KnownResourceStates.FailedToStart || finished.Snapshot.ExitCode is not (null or 0))
{
    throw new InvalidOperationException(
        $"{Migrations} ended {finished.Snapshot.State?.Text} with exit code {finished.Snapshot.ExitCode?.ToString() ?? "n/a"}, "
        + "so nothing that waits for the schema will start.");
}

foreach (var resource in Services)
{
    var settled = await notifications.WaitForResourceAsync(
        resource,
        [KnownResourceStates.Running, .. FinishedStates],
        cancellationToken);

    if (settled != KnownResourceStates.Running)
    {
        throw new InvalidOperationException($"{resource} ended {settled} instead of running.");
    }
}
```

This comes from `GraphReadiness`:
- The migration runner applies the schema and exits. Every service waits for it, so a failed run would leave the graph waiting forever; checking its exit code fails at once instead.
- Then the identity host, the API and the gateway must reach `Running`. A resource that ends instead fails the run at once.
- On any failure, the real class prints every resource's state, exit code and health before rethrowing.

The ten-minute `StartupCeiling` is only a ceiling: it turns a graph that never comes up into a failure rather than a hang.

The Angular dev server is deliberately *not* waited for: a back-end test has no reason to pay for the bundler, which is most of a cold boot.


## Sign in without a browser
The identity host registers one browser client, with the authorization code flow only: no client credentials, no password grant. There is no token to mint out of band, and adding a client for the tests would mean changing the application to suit them.

So the suite walks the real flow with an `HttpClient` and a cookie jar. It is scriptable because the gateway asks for `response_mode=query` and the client's consent is implicit, so no page in the chain needs JavaScript:

```csharp
var cookies = new CookieContainer();
var client = InsecureHttp.CreateClient(gateway, TimeSpan.FromSeconds(60), cookies);

// The gateway redirects to the identity host's login page.
var loginPage = await client.GetAsync("/bff/login?returnUrl=/", cancellationToken);
loginPage.EnsureSuccessStatusCode();

var loginUrl = loginPage.RequestMessage?.RequestUri!;
var html = await loginPage.Content.ReadAsStringAsync(cancellationToken);

var form = HiddenFields(html);        // __RequestVerificationToken among them
form["Input.Username"] = username;
form["Input.Password"] = password;
form["Input.Button"] = "login";

await PostToCallbackAsync(gateway, cookies, loginUrl, form, cancellationToken);

client.DefaultRequestHeaders.Add("X-CSRF", "1");

var session = await client.GetAsync("/bff/user", cancellationToken);
```

This is a simplification of `BffSession.SignInAsync`:
- `GET /bff/login` follows the redirects to the login form, and the cookie container keeps every cookie along the way.
- `HiddenFields` reads the hidden inputs of the server-rendered form, the antiforgery token included: a login post without it is answered 400.
- `PostToCallbackAsync` posts the form with automatic redirects off and follows each 302/303 itself with a `GET`, the way a browser would, until it reaches the gateway's `/signin-oidc` callback.
- Whether signing in worked is the gateway's to answer: `/bff/user` must return 200, or the fixture throws.

Why stop at the callback? It sets the session cookie, then redirects to the SPA. Following that would make every sign-in wait on the Angular dev server, for a page nobody reads.

## The Gherkin
Now the fun part. 🙂 A feature file reads like the behaviour, not like HTTP:

```text
Feature: Workspaces
  A write and the read that follows it, through the real gateway, over the real
  schema: what the write side commits, the read side lists.

  Scenario: A workspace created in an organization is listed in it
    Given a signed-in user
    And an organization I own
    When I create a workspace in it
    Then the organization's workspaces include it
```

The rule is simple: a `Given` states what is true before, a `When` is the one action under test, and a `Then` is what can be observed afterwards, never *how* the step observes it.

The graph is started once for the whole run, with a Reqnroll hook, and handed to each scenario's container:

```csharp
[Binding]
internal sealed class GraphHooks
{
    private static BlouppyGraph? _graph;

    [BeforeTestRun]
    public static async Task StartGraphAsync()
    {
        _graph = new BlouppyGraph();
        await _graph.InitializeAsync();
    }

    [BeforeScenario]
    public static void RegisterGraph(IObjectContainer container)
        => container.RegisterInstanceAs(_graph ?? throw new InvalidOperationException("The graph was not started."));
}
```

An `[AfterTestRun]` hook disposes it, which shuts the whole graph down, session containers included.

Then the steps. They translate Gherkin and assert, and hold no HTTP:

```csharp
[Binding]
internal sealed class WorkspaceSteps(OrganizationsApi organizations, WorkspacesApi workspaces, WorkspaceUnderTest subject)
{
    [Given("an organization I own")]
    public async Task GivenAnOrganizationIOwnAsync()
        => subject.Organization = await organizations.OwnedAsync(TestContext.Current.CancellationToken);

    [When("I create a workspace in it")]
    public async Task WhenICreateAWorkspaceInItAsync()
        => subject.Workspace = await workspaces.CreateAsync(
            Names.Unique("Workspace"),
            subject.Organization.Id,
            TestContext.Current.CancellationToken);

    [Then("the organization's workspaces include it")]
    public async Task ThenTheOrganizationsWorkspacesIncludeItAsync()
    {
        var listed = await workspaces.InOrganizationAsync(subject.Organization.Id, TestContext.Current.CancellationToken);

        listed.Should().ContainEquivalentOf(subject.Workspace);
    }
}
```

A few things worth noticing:
- The constructor parameters are resolved by Reqnroll's container, **per scenario**. `WorkspaceUnderTest`, `SignedInUser` and `LastResponse` are small, separate classes rather than one shared bag, because the session, the last raw response and the rows under test are separate concerns.
- `WorkspacesApi` and `OrganizationsApi` are thin clients over a shared `ApiClient`, which uses the signed-in `HttpClient`.
- `Names.Unique("Workspace")` gives each scenario rows it named itself. A scenario never counts what is there, so scenarios do not depend on each other.
- The `Then` re-reads the list from the API instead of trusting the object the `POST` returned: the write side and the read side, over the same real schema.

## Wait for what crosses the bus
The audit log is written off the request: the change commits with an outbox row, RabbitMQ delivers it, and a consumer records it a moment later. Reading it back at once would be flaky, so the step waits, with a bound:

```csharp
private async Task<AuditLogEntry?> WaitForEntryAsync(int organizationId, Func<AuditLogEntry, bool> match)
{
    // Written off the request, over RabbitMQ: waited for, bounded.
    var deadline = DateTimeOffset.UtcNow.AddSeconds(60);

    do
    {
        var page = await auditLog.GetAsync(organizationId, RoleChanged, TestContext.Current.CancellationToken);

        if (page.Items.FirstOrDefault(match) is { } entry)
        {
            return entry;
        }

        await Task.Delay(TimeSpan.FromMilliseconds(500), TestContext.Current.CancellationToken);
    }
    while (DateTimeOffset.UtcNow < deadline);

    return null;
}
```

The `Then` step in `AuditLogSteps` then checks what no integration test can: the actor is the subject of the real session, the channel is `App`, and the address and user agent are the ones the gateway forwarded.


## What it costs
This suite is not free:
- **Docker and the development ports.** The graph keeps the AppHost's ports, so the development containers must be stopped before a run.
- **Time.** A couple of minutes is fine on demand, too much on every push. In the code base this comes from, CI runs it on a version tag, on a pull request labelled `e2e 🧪` (and each push while the label stays), and by hand.
- **No front end.** No browser scenarios at all, on purpose for now: that is what keeps it fast.

It does not replace the integration tests either: those stay the fast, precise net for each endpoint.


## Conclusion
`Aspire.Hosting.Testing` lets us start the very graph the AppHost describes, from a test project, with a few adjustments: fixed ports, containers of the run's own, and a pinned environment. Readiness comes from the resource states Aspire reports, not from a timer, and a failed migration fails the run at once.

On top of that, a scripted walk through the real OpenID Connect flow gives us a genuine cookie session without a browser, and Reqnroll keeps the scenarios readable while small, per-scenario contexts keep the steps honest. The result reaches the places our integration tests cannot: the cookie exchanged for a token, the token accepted by the API, and an event crossing RabbitMQ.

This is how the end-to-end suite of [Blouppy Starter](https://starter.blouppy.com/) is built, over its gateway, identity host, API and broker. Its [end-to-end guide](https://docs.starter.blouppy.com/guides/testing/end-to-end/) lists what each feature file proves.

*Thanks for reading! 🙂*
