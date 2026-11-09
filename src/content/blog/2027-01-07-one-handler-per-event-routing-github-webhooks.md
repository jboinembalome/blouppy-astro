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

A webhook endpoint starts with one event. GitHub tells us an issue was opened, we write a method for it, and the controller calls it. Then come pull requests, reviews, pushes, the app being installed or suspended. Each event becomes a `case` in a `switch` on the event name:

```csharp
internal sealed class WebhookProcessor(
    IIssuesRepository issuesRepository,
    IPullRequestLinker pullRequestLinker,
    ICommitLinker commitLinker,
    IIntegrationsRepository integrationsRepository)
{
    public Task ProcessAsync(string eventName, string payload, CancellationToken cancellationToken)
        => eventName switch
        {
            "issues" => HandleIssueAsync(payload, cancellationToken),
            "pull_request" => HandlePullRequestAsync(payload, cancellationToken),
            "push" => HandlePushAsync(payload, cancellationToken),
            _ => Task.CompletedTask
        };
}
```

Nothing is wrong with it at three events. The trouble is the direction it grows in. Every new event edits this class and adds a dependency that one branch uses. Its tests mock all of them to exercise one case.


## A table of handlers
The fix is to give each event a class behind one interface, and pick the class by a key that arrives at run time. Each handler is a Strategy. Martin Fowler calls the move **Replace Conditional with Polymorphism**: each branch becomes an implementation of one method.

A project-management app built on [Blouppy Starter](https://starter.blouppy.com/) links issues to GitHub this way. A pull request that names an issue moves it on the board. A commit is linked to the issues its message mentions. Uninstalling the GitHub App disconnects the integration. Each `X-GitHub-Event` value has one class, which names its own key, and a router indexes them (trimmed):

```csharp
internal interface IGitHubEventHandler
{
    // The X-GitHub-Event value it answers, such as "issues" or "pull_request".
    string Event { get; }

    Task<GitHubEventOutcome> HandleAsync(
        InboundDelivery delivery,
        ExternalIntegration integration,
        CancellationToken cancellationToken = default);
}

internal sealed class GitHubEventRouter
{
    private readonly IReadOnlyDictionary<string, IGitHubEventHandler> _handlers;

    public GitHubEventRouter(IEnumerable<IGitHubEventHandler> handlers)
    {
        // ToDictionary throws on two handlers for one event, which is a bug to find at the first
        // delivery rather than a choice to make silently.
        _handlers = handlers.ToDictionary(x => x.Event, StringComparer.Ordinal);
    }

    public IGitHubEventHandler? Find(string @event)
        => _handlers.GetValueOrDefault(@event);
}
```

The container does the wiring. When several classes are registered for one interface, asking for `IEnumerable<IGitHubEventHandler>` returns all of them. The module registers its handlers by assembly scan, so a new event is one new file and no registration line. Six exist today, from `installation` to `push`.

Two details in the router matter. `ToDictionary` throws on a duplicate key, so two classes claiming `"push"` fail loudly instead of leaving one silently unused. And the comparer is ordinal: GitHub sends event names in lower case, and the router does not guess.

The lifetime matters too. The handlers depend on repositories, which are scoped, so the handlers and the router are scoped as well. A singleton router would keep the first scope's handlers, and their `DbContext`, for the life of the process. Rebuilding a six-entry dictionary per scope costs nothing.


## The caller
GitHub deliveries are stored first and routed later. The controller checks the signature, the delivery is saved as a row, and the endpoint answers `202 Accepted`. A consumer then processes it off the request. It asks the router for a handler, finds the integration from the installation id, and calls `HandleAsync`.

An event with no handler, such as `ping`, is not an error. The delivery is marked `Ignored` and stays in the delivery history. That is what makes a missing handler visible: an event we expected to act on shows up there as ignored. A handler also returns `Ignored` itself when it understood the event and chose not to act. What every event shares, finding the integration, the transaction, the failure handling, stays in one place.

The handlers do not ban the `switch`. Inside one event, GitHub sends an `action`, and `InstallationEventHandler` branches on `deleted`, `suspend` and `unsuspend`. Those branches share the handler's one dependency, each is a few lines, and GitHub closes the list. That is where a `switch` belongs. The table works at the level where each case has different dependencies.


## Why not keyed services
Since .NET 8, the container can do the lookup itself:

```csharp
services.AddKeyedScoped<IGitHubEventHandler, PushEventHandler>("push");

var handler = serviceProvider.GetKeyedService<IGitHubEventHandler>(delivery.Event);
```

It removes the router. But for a key that arrives with the request, the caller has to take an `IServiceProvider`, which hides its dependencies. The scan has to read the key from an attribute or a constant, since the container cannot ask an instance before building it. And two registrations under one key do not throw: the last one wins. The router keeps the key next to the code that handles it, and refuses the duplicate.


## Testing it, and its gap
The router is tested with fake handlers and no container: it finds `"issues"`, returns `null` for `"Issues"` or `"ping"`, and throws on two handlers for one event. The delivery service is tested with a router built from one fake handler. Each real handler is tested with only its own dependencies mocked.

No test builds the router over the module's real handlers, though. So the duplicate check runs the first time a scope resolves the router: the first webhook after a deploy. `ValidateOnBuild` does not catch it either, because it checks that dependencies resolve without running constructors. A test that registers the module and resolves the router would move that failure to the build.


## When a switch stays better
The table has costs. A missing handler is found at run time, as an ignored delivery. "Go to definition" stops at the interface, so following a `pull_request` delivery means searching for the string. And a typo in `Event` compiles.

For three events that fit in a few lines and share their dependencies, a `switch` is clearer: the whole flow is on one screen. The table pays off when the cases have different dependencies, grow independently, and come from an open list, as GitHub's events do. A good test is the constructor. When it takes dependencies only one branch uses, it is time to split.


## References
- [Replace Conditional with Polymorphism](https://refactoring.com/catalog/replaceConditionalWithPolymorphism.html) — Martin Fowler's refactoring behind one class per case.
- [Dependency injection in .NET](https://learn.microsoft.com/dotnet/core/extensions/dependency-injection) — Microsoft Learn: multiple registrations, lifetimes and keyed services.
- [Webhook events and payloads](https://docs.github.com/en/webhooks/webhook-events-and-payloads) — GitHub Docs: every `X-GitHub-Event` value and its actions.
- [Signed outgoing webhooks in ASP.NET Core](/blog/2026-09-19-signed-outgoing-webhooks-in-aspnet-core/) — the other direction: sending webhooks.
