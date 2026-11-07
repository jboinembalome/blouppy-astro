---
templateKey: 'blog-post'
title: 'End-to-end tests of a distributed .NET app with Aspire.Hosting.Testing'
date: 2026-09-25T09:00:00.000Z
updated: 2026-11-07T09:00:00.000Z
author: Jimmy Boinembalome
authorimage: /img/jimmy.jpg
category: C#
topic: 'Testing'
illustration: 1
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

Our integration tests are fast, but they lie a little: `WebApplicationFactory` hosts the API alone, the current user is a mock, and the bus runs in process. They never see the gateway exchanging its session cookie for an access token, the API accepting that token, or an event crossing RabbitMQ before a consumer writes a row. That is exactly where a distributed application breaks.

If an Aspire AppHost already describes the system, a test project can start that very graph and talk to it over HTTP. In this article, we will build an end-to-end suite with [Aspire.Hosting.Testing](https://learn.microsoft.com/dotnet/aspire/testing/overview) and [Reqnroll](https://reqnroll.net/): real PostgreSQL, real RabbitMQ, a real identity host and a real API behind a real gateway, with a sign-in through the real OpenID Connect flow. Without a browser, it runs in a couple of minutes.


## Prerequisites
- The [.NET 10 SDK](https://dotnet.microsoft.com/download/dotnet/10.0).
- Docker, for the containers of the graph.
- An existing Aspire AppHost that describes your system.

> **_Note:_**  If your AppHost also starts npm apps, its build may need Node and an installed front-end workspace, even if the tests never use them. Plan for it in CI.


## The test projects
The suite has two projects: a **fixtures** project that starts the graph and signs in, and an **API** project with the Gherkin and the steps. The fixtures project references the AppHost itself:

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

The project reference generates the `Projects.Blouppy_Aspire_AppHost` type that the testing builder starts (versions are managed centrally, hence no `Version=`). The scenarios project references Reqnroll, the open-source successor of SpecFlow, through `Reqnroll.xunit.v3`, which turns each `.feature` file into [xUnit v3](https://xunit.net/docs/getting-started/v3/getting-started) tests.


## Build the graph from the real AppHost
The key decision is to **not** describe the system a second time. The AppHost's `Program.cs` already says what the system is; the suite reads it.

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

    Gateway = _app.GetEndpoint(GraphReadiness.Gateway, "https");
}
```

This is a trimmed version of `BlouppyGraph` (`e2e/Blouppy.E2E.Fixtures/BlouppyGraph.cs`). Each adjustment has a reason:
- **Fixed ports.** The testing builder [randomizes ports by default](https://learn.microsoft.com/dotnet/aspire/testing/overview). Here every host reads the others' URLs from configuration, and the gateway's redirect URI is registered at the identity host, so the graph keeps the ports the AppHost declares.
- **Parameters.** The secret parameters normally come from user secrets; `AppHostParameters.Defaults` supplies throwaway values, which a `Parameters__<name>` variable can override.
- **Session containers.** Development keeps PostgreSQL, RabbitMQ and the others in persistent containers on named volumes, and reusing them would sign in with whatever password first created the volume. `ContainerLifetime.Session` gives the run its own containers (the real fixture also makes each volume anonymous).
- **Development, pinned.** The sample data is only seeded in Development, so the environment is set on each project rather than inherited.

The real fixture also adds a Keycloak container with `AddKeycloak`, so single sign-on scenarios run against a real OpenID Connect provider.


## Wait for the graph, not for a clock
A `Task.Delay` is too short on CI and too long everywhere else. Aspire already knows the state of each resource, so `GraphReadiness` asks it:

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
```

The migration runner applies the schema and exits. Every service waits for it, so a failed run would leave the graph waiting forever; checking its exit code fails at once instead. The identity host, the API and the gateway must then reach `Running` (the same `WaitForResourceAsync`, given a list of target states), and on any failure the class prints every resource's state before rethrowing. The ten-minute `StartupCeiling` only turns a hang into a failure. The Angular dev server is deliberately *not* awaited: a back-end test has no reason to pay for the bundler.


## Sign in without a browser
The identity host registers one browser client, with the [authorization code flow](https://openid.net/specs/openid-connect-core-1_0.html#CodeFlowAuth) only, and adding a client for the tests would change the application to suit them. So the suite walks the real flow with an `HttpClient` and a cookie jar. No page in the chain needs JavaScript, because the gateway asks for `response_mode=query` and consent is implicit:

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
- `HiddenFields` reads the hidden inputs of the server-rendered form, including the antiforgery token: a login post without it gets a 400.
- `PostToCallbackAsync` posts with automatic redirects off and follows each 302/303 with a `GET`, as a browser would, up to the gateway's `/signin-oidc` callback. It stops there: the callback sets the session cookie, and the next redirect would only wait on the Angular dev server.
- The gateway decides whether signing in worked: `/bff/user` must return 200, or the fixture throws.


## The Gherkin
A feature file reads like the behavior, not like HTTP:

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

A `Given` states what is true before, a `When` is the one action under test, and a `Then` is what can be observed afterwards. The graph starts once for the whole run, in a Reqnroll [hook](https://docs.reqnroll.net/latest/automation/hooks.html): `[BeforeTestRun]` initializes a static `BlouppyGraph`, `[BeforeScenario]` registers it in each scenario's `IObjectContainer`, and `[AfterTestRun]` disposes it, which shuts down the whole graph, session containers included.

The steps translate Gherkin and assert; they hold no HTTP:

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

- Reqnroll resolves the constructor parameters **per scenario** ([context injection](https://docs.reqnroll.net/latest/automation/context-injection.html)); `WorkspaceUnderTest` is one of several small context classes.
- `Names.Unique("Workspace")` gives each scenario rows it named itself, so scenarios never depend on each other.
- The `Then` re-reads the list instead of trusting what the `POST` returned.


## Wait for what crosses the bus
The audit log is written off the request: the change commits with an outbox row, RabbitMQ delivers it, and a consumer records it a moment later. Reading it back at once would be flaky, so the step polls, with a bound:

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

The `Then` in `AuditLogSteps` then checks what no integration test can: the actor is the subject of the real session, the channel is `App`, and the address and user agent are the ones the gateway forwarded.


## What it costs
- **Docker and the development ports.** The graph keeps the AppHost's ports, so the development containers must be stopped before a run.
- **Time.** A couple of minutes is fine on demand, too much on every push. CI runs it on a version tag, on a pull request carrying the end-to-end label (and each push while it stays), and by hand.
- **No front end.** No browser scenarios, on purpose for now: that keeps it fast.

It does not replace the integration tests, which stay the fast, precise net for each endpoint.


## Conclusion
`Aspire.Hosting.Testing` starts the very graph the AppHost describes, with fixed ports, the run's own containers and a pinned environment. Readiness comes from the resource states Aspire reports, a scripted OpenID Connect flow gives a genuine session without a browser, and Reqnroll keeps the scenarios readable. The suite reaches what integration tests cannot: the cookie exchanged for a token, the token accepted by the API, and an event crossing RabbitMQ.

This is how the end-to-end suite of [Blouppy Starter](https://starter.blouppy.com/) is built. Its [end-to-end guide](https://docs.starter.blouppy.com/guides/testing/end-to-end/) lists what each feature file proves.

## References
- [Aspire testing overview (Microsoft Learn)](https://learn.microsoft.com/dotnet/aspire/testing/overview) — `DistributedApplicationTestingBuilder`, and disabling port randomization.
- [Manage the AppHost in tests (Microsoft Learn)](https://learn.microsoft.com/dotnet/aspire/testing/manage-app-host) — building, starting and disposing the AppHost from a test.
- [Aspire.Hosting.Testing (NuGet)](https://www.nuget.org/packages/Aspire.Hosting.Testing) — the package.
- [Reqnroll documentation](https://docs.reqnroll.net/latest/) — Gherkin, bindings, hooks and context injection.
- [Getting started with xUnit.net v3](https://xunit.net/docs/getting-started/v3/getting-started) — the test framework under Reqnroll.
- [OpenID Connect Core 1.0](https://openid.net/specs/openid-connect-core-1_0.html) — the authorization code flow the suite walks through.
- [Blouppy Starter documentation: end-to-end tests](https://docs.starter.blouppy.com/guides/testing/end-to-end/) — what each feature file proves.
