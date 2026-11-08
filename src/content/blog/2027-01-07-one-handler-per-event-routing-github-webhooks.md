---
templateKey: 'blog-post'
title: 'One handler per event: routing GitHub webhooks without a switch'
date: 2027-01-07T09:00:00.000Z
author: Jimmy Boinembalome
authorimage: /img/jimmy.jpg
category: C#
topic: 'Architecture'
illustration: 2
categorycolor: bg-purple-100 text-purple-800
featuredpost: true
description: >-
  Learn how to route incoming webhooks in C# to one handler class per event with a dictionary built from DI, how to test it, and when a plain switch stays the better choice.
tags:
  - Development
  - C#
  - Design Patterns
  - ASP.NET Core
---

A webhook endpoint starts with one event. GitHub tells us an issue was opened, we write a method for it, and the controller calls it. Then come pull requests, reviews, pushes, the app being installed or suspended. Each event is a `case` in a `switch` on the event name, each `case` needs its own repositories, and the class that holds the `switch` ends up with a constructor of twelve parameters, most of them used by one branch.

In this article, we will look at routing to one handler per key: a dictionary of handlers, filled by dependency injection, that replaces the `switch`. We will start with the shape in a few lines, then follow the GitHub integration of a project-management app built on [Blouppy Starter](https://starter.blouppy.com/), look at keyed services as an alternative, see how to test the router, and finish with what the pattern costs and when a `switch` is enough.


## The switch that grows
Here is the usual first version, for any webhook provider:

```csharp
internal sealed class WebhookProcessor(
    IIssuesRepository issuesRepository,
    IPullRequestLinker pullRequestLinker,
    ICommitLinker commitLinker,
    IIntegrationsRepository integrationsRepository,
    ILogger<WebhookProcessor> logger)
{
    public async Task ProcessAsync(string eventName, string payload, CancellationToken cancellationToken)
    {
        switch (eventName)
        {
            case "issues":
                await HandleIssueAsync(payload, cancellationToken);
                break;

            case "pull_request":
                await HandlePullRequestAsync(payload, cancellationToken);
                break;

            case "push":
                await HandlePushAsync(payload, cancellationToken);
                break;

            default:
                logger.LogInformation("No handler for {Event}", eventName);
                break;
        }
    }

    // HandleIssueAsync, HandlePullRequestAsync, HandlePushAsync...
}
```

Nothing is wrong with it at three events. The trouble is the direction it grows in. Every new event edits this class, adds a dependency to its constructor and a private method to its body, and its tests have to mock every dependency to exercise one branch. The open/closed principle from the [introduction to SOLID principles](/blog/2022-02-28-introduction-to-solid-principles/) names the problem: the class is open to modification every time the behaviour is extended.


## The pattern: a table of handlers
The fix has no Gang of Four name of its own. Each handler is a variant behind one interface, which is the **Strategy** pattern, a **behavioral** pattern of the Gang of Four book. What is added is the selection: the strategy is looked up in a table by a key that arrives at runtime. Martin Fowler's *Refactoring* describes the move from one side as **Replace Conditional with Polymorphism**: each branch of the conditional becomes an implementation of one method. The Command pattern, also behavioral, is a neighbour: it turns a request into an object. Here the request is already an object (the stored delivery), and the handlers are what varies.

In C#, the shape is an interface that names its own key, and a router that indexes the implementations:

```csharp
internal interface IWebhookEventHandler
{
    string Event { get; }

    Task HandleAsync(string payload, CancellationToken cancellationToken = default);
}

internal sealed class WebhookEventRouter
{
    private readonly IReadOnlyDictionary<string, IWebhookEventHandler> _handlers;

    public WebhookEventRouter(IEnumerable<IWebhookEventHandler> handlers)
        => _handlers = handlers.ToDictionary(x => x.Event, StringComparer.Ordinal);

    public IWebhookEventHandler? Find(string @event)
        => _handlers.GetValueOrDefault(@event);
}
```

The container does the wiring. When several implementations are registered for one service type, asking for `IEnumerable<IWebhookEventHandler>` returns all of them, so the router never names a concrete handler:

```csharp
services.AddScoped<IWebhookEventHandler, IssuesEventHandler>();
services.AddScoped<IWebhookEventHandler, PullRequestEventHandler>();
services.AddScoped<IWebhookEventHandler, PushEventHandler>();
services.AddScoped<WebhookEventRouter>();
```

Each handler takes only the dependencies it uses, and a new event is a new class.


## The real example: GitHub deliveries
The project-management app links issues to GitHub: a pull request that names an issue moves it forward on the board, a commit on the default branch is linked to the issues its message mentions, and uninstalling the GitHub App disconnects the integration. Each of those is one `X-GitHub-Event` value, and each has one class.

The interface says so in its summary:

```csharp
namespace Blouppy.ExternalIntegrations.GitHub;

/// <summary>
/// Handles one GitHub event — one class per <c>X-GitHub-Event</c> value, found by assembly scan, so
/// supporting a new event is one new file.
/// </summary>
internal interface IGitHubEventHandler
{
    // The X-GitHub-Event value it answers, such as "issues" or "pull_request".
    string Event { get; }

    Task<GitHubEventOutcome> HandleAsync(
        InboundDelivery delivery,
        ExternalIntegration integration,
        CancellationToken cancellationToken = default);
}
```

The handler returns an outcome, `Processed` or `Ignored`, so that "understood and deliberately not acted on" is recorded on the delivery rather than looking like success. A handler that fails throws, and the caller records the delivery as failed. Six handlers implement the interface today: `installation`, `installation_repositories`, `issues`, `pull_request`, `pull_request_review` and `push`.

The router is the one from the previous section, with a comment on the line that matters:

```csharp
namespace Blouppy.ExternalIntegrations.GitHub;

internal sealed class GitHubEventRouter
{
    private readonly IReadOnlyDictionary<string, IGitHubEventHandler> _handlers;

    public GitHubEventRouter(IEnumerable<IGitHubEventHandler> handlers)
    {
        ArgumentNullException.ThrowIfNull(handlers);

        // ToDictionary throws on two handlers for one event, which is a bug to find at the first
        // delivery rather than a choice to make silently.
        _handlers = handlers.ToDictionary(x => x.Event, StringComparer.Ordinal);
    }

    public IGitHubEventHandler? Find(string @event)
        => _handlers.GetValueOrDefault(@event);
}
```

`Enumerable.ToDictionary` throws an `ArgumentException` on a duplicate key. Without that, two classes claiming `"push"` would leave one of them silently unused, depending on registration order. The comparer is ordinal, so `"Issues"` finds nothing: GitHub sends the event names in lower case, and the router does not guess.

The handlers are registered by assembly scan, so no one has to remember a line in a registration file:

```csharp
namespace Blouppy.ExternalIntegrations.GitHub;

internal static class GitHubEventHandlerServiceCollectionExtensions
{
    extension(IServiceCollection services)
    {
        public IServiceCollection AddGitHubEventHandlers(Assembly assembly)
        {
            foreach (var (implementation, service) in assembly.GetImplementationsOf(typeof(IGitHubEventHandler)))
            {
                services.AddScoped(service, implementation);
            }

            services.AddScoped<GitHubEventRouter>();

            return services;
        }
    }
}
```

`GetImplementationsOf` is a small helper of the shared kernel that returns every non-abstract class of the assembly assignable to the interface. The module's own registration calls `AddGitHubEventHandlers(assembly)` with its assembly.

Note the lifetime. The handlers depend on repositories, which are scoped, so they are scoped too, and the router that holds them must be scoped as well: a singleton router would keep the first scope's handlers, and their `DbContext`, for the life of the process. The price is that the dictionary is rebuilt in every scope that needs the router. For six entries, that is nothing.


## The caller: stored first, routed later
The router is used by `InboundDeliveryService`. The webhook controller checks the signature, then the service stores the delivery as a row and publishes an integration event in the same commit; the controller answers `202 Accepted`. Processing happens off the request, when a consumer receives that event and calls `ProcessAsync`, under the system actor. That method asks for the outcome and marks the row accordingly:

```csharp
private async Task<GitHubEventOutcome> RouteAsync(
    InboundDelivery delivery,
    CancellationToken cancellationToken)
{
    var handler = gitHubEventRouter.Find(delivery.Event);

    if (handler is null)
    {
        logger.LogInformation("No handler for GitHub event {Event}; ignoring delivery {DeliveryId}", delivery.Event, delivery.Id);

        return GitHubEventOutcome.Ignored;
    }

    if (delivery.InstallationId is null)
    {
        return GitHubEventOutcome.Ignored;
    }

    var searchIntegration = await externalIntegrationsRepository.TryGetAsync(
        ExternalIntegrationProvider.GitHub,
        delivery.InstallationId,
        cancellationToken);

    if (searchIntegration.NotFound)
    {
        return GitHubEventOutcome.Ignored;
    }

    return await handler.HandleAsync(delivery, searchIntegration.Value, cancellationToken);
}
```

An event with no handler, such as `ping`, is not an error. It is logged, and the delivery row is marked `Ignored`. It stays in the delivery history like any other, which is what makes a missing handler visible: an event we expected to act on shows up there as ignored.

The work common to every event (finding the integration from the installation id, the transaction, the failure handling) stays in one place. A handler only receives what it needs.


## A switch inside a handler is fine
The handlers do not ban the `switch`. Inside one event, GitHub sends an `action`, and the handlers branch on it. Here is `InstallationEventHandler`, trimmed:

```csharp
internal sealed class InstallationEventHandler(
    IRepositoryLinksRepository repositoryLinksRepository) : IGitHubEventHandler
{
    public string Event
        => "installation";

    public async Task<GitHubEventOutcome> HandleAsync(
        InboundDelivery delivery,
        ExternalIntegration integration,
        CancellationToken cancellationToken = default)
    {
        switch (delivery.Action)
        {
            case "deleted":
                integration.Disconnect();

                foreach (var repositoryLink in await repositoryLinksRepository.GetAsync(integration.Id, cancellationToken))
                {
                    repositoryLink.Deactivate();
                }

                return GitHubEventOutcome.Processed;

            case "suspend" when integration.Status != ExternalIntegrationStatus.Disconnected:
                integration.Suspend();

                return GitHubEventOutcome.Processed;

            case "unsuspend" when integration.Status != ExternalIntegrationStatus.Disconnected:
                integration.Unsuspend();

                return GitHubEventOutcome.Processed;

            default:
                return GitHubEventOutcome.Ignored;
        }
    }
}
```

The actions share the handler's one dependency, each branch is a few lines, and the list is closed: GitHub defines it. That is where a `switch` belongs. `PullRequestEventHandler` does the same with a `switch` expression that maps an action to the board moves it triggers. The table of handlers works at the level where each case has different dependencies; below that level, a `switch` is easier to read.


## Keyed services as an alternative
Since .NET 8, the container supports keyed services. The key moves from the handler to the registration, and the container does the lookup:

```csharp
services.AddKeyedScoped<IGitHubEventHandler, IssuesEventHandler>("issues");
services.AddKeyedScoped<IGitHubEventHandler, PushEventHandler>("push");

// In the caller, with the key known only at runtime:
var handler = serviceProvider.GetKeyedService<IGitHubEventHandler>(delivery.Event);
```

It removes the router class, and `[FromKeyedServices("push")]` covers the case where the key is known at compile time. For a key that arrives with the request, though, the caller has to take an `IServiceProvider` and resolve from it, which hides its dependencies. An assembly scan also needs to read the key from somewhere, an attribute or a constant, since the container cannot ask an instance before creating it. And two registrations under the same key do not throw: the last one wins. The router with `ToDictionary` keeps the key next to the code that handles it and refuses the duplicate, which is why the app uses it.


## Testing it
The router is tested with fake handlers, without a container:

```csharp
[Fact]
public void Should_refuse_two_handlers_when_they_declare_the_same_event()
{
    // Act
    var act = () => new GitHubEventRouter([Given_a_handler("issues"), Given_a_handler("issues")]);

    // Assert
    act.Should()
        .Throw<ArgumentException>();
}

private static IGitHubEventHandler Given_a_handler(string @event)
    => Mock.Of<IGitHubEventHandler>(x => x.Event == @event);
```

Two more tests cover the lookup: the handler that declares `"issues"` is returned for `"issues"`, and `"ping"` or `"Issues"` returns `null`. `InboundDeliveryService` is tested with a router built from one fake handler, which is how its tests check that a `ping` delivery ends up `Ignored` and that the handler is never called. Each real handler is tested on its own, with only its own dependencies mocked.

The scan has its own test, over a test assembly that contains two handlers and an abstract one: the container returns the two concrete ones. What no test does is build the router over the module's real handlers. The duplicate check therefore runs when a scope first resolves the router, and since the webhook request resolves `InboundDeliveryService`, a duplicate would make the first webhook after a deploy fail. The container's `ValidateOnBuild` option does not catch it either, because it checks that dependencies can be resolved, without running constructors. A test that registers the module and resolves `GitHubEventRouter` would move that failure to the build.


## What it costs
- **A missing handler is found at runtime.** The compiler cannot tell that `"check_run"` has no class. The app makes it visible as an ignored delivery in the history, but nothing fails.
- **"Go to definition" stops at the interface.** From `RouteAsync`, the IDE shows `IGitHubEventHandler.HandleAsync`, not the six implementations. To follow a `pull_request` delivery, we search for the string `"pull_request"`.
- **A string is the key.** A typo in `Event` compiles. Constants, or a test per handler that asserts its key, help.
- **More files.** Six handlers, six test classes, a router, a registration helper.


## When a switch stays better
For three events that each fit in a few lines and share the same dependencies, the `switch` (or a `switch` expression returning a delegate) is clearer: the whole flow is on one screen, and the compiler warns on a `switch` expression over an enum that misses a case. The table pays off when the cases have different dependencies, when they grow independently, and when the list is open, as GitHub's list of events is. A good test is the constructor: when the class that holds the `switch` takes dependencies that only one branch uses, it is time to split.


## Conclusion
Routing to one handler per key replaces a growing `switch` with a dictionary of strategies. In the project-management app, each GitHub event is one `IGitHubEventHandler` that names its `X-GitHub-Event` value, an assembly scan registers them, and `GitHubEventRouter` indexes them with `ToDictionary`, which refuses two handlers for one event. An event without a handler is stored and marked ignored rather than lost. Inside each handler, the actions stay in a plain `switch`, because that is the level where a `switch` reads best. For the other direction, sending webhooks, see [signed outgoing webhooks in ASP.NET Core](/blog/2026-09-19-signed-outgoing-webhooks-in-aspnet-core/).


## References

- [Design Patterns: Elements of Reusable Object-Oriented Software](https://www.pearson.com/en-us/subject-catalog/p/design-patterns-elements-of-reusable-object-oriented-software/P200000009480) — the Gang of Four book that names the Strategy and Command patterns.
- [Replace Conditional with Polymorphism](https://refactoring.com/catalog/replaceConditionalWithPolymorphism.html) — Martin Fowler's refactoring catalog: the refactoring behind one class per case.
- [Dependency injection in .NET](https://learn.microsoft.com/dotnet/core/extensions/dependency-injection) — Microsoft Learn: multiple registrations, `IEnumerable<T>`, lifetimes and keyed services.
- [Enumerable.ToDictionary](https://learn.microsoft.com/dotnet/api/system.linq.enumerable.todictionary) — Microsoft Learn: the overloads, and the `ArgumentException` on a duplicate key.
- [Webhook events and payloads](https://docs.github.com/en/webhooks/webhook-events-and-payloads) — GitHub Docs: every `X-GitHub-Event` value and its actions.
- [Introduction to SOLID principles](/blog/2022-02-28-introduction-to-solid-principles/) — the open/closed principle the handlers follow.
- [Signed outgoing webhooks in ASP.NET Core](/blog/2026-09-19-signed-outgoing-webhooks-in-aspnet-core/) — the other direction: sending webhooks with a signature and retries.
