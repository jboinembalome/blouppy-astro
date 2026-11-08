---
templateKey: 'blog-post'
title: 'The Observer pattern in C#: domain events and their handlers'
date: 2026-12-15T09:00:00.000Z
author: Jimmy Boinembalome
authorimage: /img/jimmy.jpg
category: C#
topic: 'Architecture'
illustration: 1
categorycolor: bg-purple-100 text-purple-800
featuredpost: true
description: >-
  Learn the Observer pattern in C#: its classic shape, how domain events and their handlers apply it, how it compares to C# events and IObservable, and what it costs.
tags:
  - Development
  - C#
  - Design Patterns
  - DDD
---

When a workspace is created, several things have to follow. It needs a first team with its owner in it, and the rest of the system needs to hear about it: the audit log, the webhooks of the organization. The simplest code calls each of them from the service that creates the workspace. Every new reaction then means editing that service, and the service ends up depending on everything that cares about workspaces.

In this article, we will look at the **Observer pattern**: the problem it solves, its classic shape, the observer flavours a .NET developer already uses, how [Blouppy Starter](https://starter.blouppy.com/) applies it with domain events and their handlers, and what it costs.


## The problem and the classic shape
The Observer pattern is one of the behavioral patterns of the Gang of Four. Its intent: when one object changes state, all its dependents are notified, without the object knowing who they are. The object that changes is the **subject**; the dependents are the **observers**.

Here is the shape from the book, in C#:

```csharp
namespace Observers;

public interface IObserver
{
    void Update(Order order);
}

public sealed class Order
{
    private readonly List<IObserver> _observers = [];

    public string Status { get; private set; } = "Draft";

    public void Attach(IObserver observer) => _observers.Add(observer);

    public void Detach(IObserver observer) => _observers.Remove(observer);

    public void Submit()
    {
        Status = "Submitted";

        foreach (var observer in _observers)
        {
            observer.Update(this);
        }
    }
}
```

The subject depends on one interface, never on a concrete observer. Adding a reaction means writing a new `IObserver` and attaching it; `Order` does not change.


## The flavours .NET developers already use
**C# events** are the Observer pattern built into the language. The `event` keyword holds the list of delegates, `+=` attaches, `-=` detaches:

```csharp
public sealed class Order
{
    public event EventHandler? Submitted;

    public void Submit() => Submitted?.Invoke(this, EventArgs.Empty);
}
```

They come with a well-known trap. The subject holds a strong reference to every subscriber through its delegate. When a long-lived subject (a singleton, a static, a main window) is observed by short-lived objects that never unsubscribe, the garbage collector cannot reclaim them: a memory leak that no exception ever reports. The rule is to unsubscribe in `Dispose`, or to avoid attaching short-lived observers to long-lived subjects at all.

**`IObservable<T>` and `IObserver<T>`**, in the `System` namespace, are the push-based version for streams of values: an observer receives `OnNext`, `OnError` and `OnCompleted`, and `Subscribe` returns an `IDisposable` that detaches it. The interfaces ship with .NET; the operators (`Where`, `Throttle`, `Buffer`) come from the Rx.NET library, `System.Reactive`.

On the **front end**, Angular developers use observers every day. An RxJS `Subject` is the classic shape, with `subscribe` and `unsubscribe`, and the same leak appears when a subscription outlives its component. Angular signals push the idea further: a `computed()` or an `effect()` observes the signals it reads, and the framework tracks the dependencies and their cleanup.

All three share one property: the observers live in the same process and are called while the subject is changing. That differs from **integration events on a bus**, where the subscriber may be another process, runs later, and may run more than once. The Observer pattern describes the first case. The second is publish-subscribe messaging, which has its own concerns: delivery guarantees, retries, idempotency.


## The subject: an aggregate that records a fact
Blouppy Starter does not let an entity keep a list of observers. Its aggregates derive from `HasDomainEventsBase`, in `Blouppy.SharedKernel/DomainEvents`:

```csharp
namespace Blouppy.SharedKernel.DomainEvents;

public abstract class HasDomainEventsBase
{
    private readonly List<IDomainEvent> _domainEvents = [];

    [NotMapped]
    public IReadOnlyCollection<IDomainEvent> DomainEvents => _domainEvents.AsReadOnly();

    protected void AddDomainEvent(IDomainEvent domainEvent)
        => _domainEvents.Add(domainEvent);

    internal void ClearDomainEvents() => _domainEvents.Clear();
}
```

Compared to the classic `Order`, the list holds **events**, not observers. There is no `Attach`, no `Notify`. The `Workspace` aggregate only says what happened to it:

```csharp
namespace Blouppy.Workspaces.Models;

public sealed class Workspace(
    string name,
    Colour colour,
    UserId ownerId,
    OrganizationId organizationId) : AuditableEntityBase<WorkspaceId>
{
    public void MarkAsCreated()
        => AddDomainEvent(new WorkspaceCreatedDomainEvent(
            workspaceId: Exceptions.ThrowIfNullOrNegativeOrZero(Id),
            ownerId: Exceptions.ThrowIfNullOrWhiteSpace(ownerId),
            organizationId: OrganizationId));
}
```

`WorkspaceCreatedDomainEvent` is a small class deriving from `DomainEventBase`, which stamps `DateOccurred`. The `Workspace` class sits in `Blouppy.Workspaces.Models`, a project with no reference to a container, a database or a bus: it could not call an observer even if it wanted to. This is the pattern with one more level of indirection. The subject records the fact, and someone else delivers it.


## The observers: one handler per reaction
An observer is a class implementing `IDomainEventHandler<TDomainEvent>`, an interface of the shared kernel that extends `IEventHandler<T>` from the `Blouppy.Events` package:

```csharp
namespace Blouppy.SharedKernel.DomainEvents;

public interface IDomainEventHandler<in TDomainEvent> : IEventHandler<TDomainEvent>
    where TDomainEvent : IDomainEvent
{
}
```

Two handlers observe `WorkspaceCreatedDomainEvent`. The first one, in `Blouppy.Workspaces/Teams/DomainEventHandlers`, creates the first team:

```csharp
namespace Blouppy.Workspaces.Teams.DomainEventHandlers;

internal sealed class CreateTeamWhenWorkspaceCreatedDomainEventHandler(
    ITeamsRepository teamsRepository) : IDomainEventHandler<WorkspaceCreatedDomainEvent>
{
    public async Task HandleAsync(WorkspaceCreatedDomainEvent @event, CancellationToken cancellationToken)
    {
        var team = new Team(
            name: $"Team - {@event.WorkspaceId}",
            workspaceId: @event.WorkspaceId,
            memberIds: [@event.OwnerId]);

        await teamsRepository.AddAsync(team, cancellationToken);
    }
}
```

The second one, `PublishIntegrationEventWhenWorkspaceCreatedDomainEventHandler`, turns the fact into a `WorkspaceCreatedIntegrationEvent` through `IIntegrationEventPublisher<T>`, for the modules that listen on the bus. Neither handler knows the other exists, and `Workspace` knows neither of them.

The name `<Action>When<Event>DomainEventHandler` lets a file search on the event list every reaction to it.

Attaching is done by the container. Each domain registers its own handlers in `ServiceCollectionExtensions.cs`:

```csharp
services.AddBlouppyEvents(options => options.RegisterServicesFromAssemblies(assembly));
```

`AddBlouppyEvents` scans the assembly for `IEventHandler<T>` implementations and registers them. Adding an observer is adding a class: no list to edit, no `Attach` to call. The flip side is that forgetting this call breaks nothing at build time; the domain silently stops reacting to its events.


## The dispatch
Something still has to call the observers. In the Starter, an EF Core `SaveChangesInterceptor`, `PublishDomainEventsInterceptor`, collects the tracked entities that have events, and `DomainEventPublisher` copies and clears each entity's list before handing every event to the `IPublisher` of `Blouppy.Events`. That publisher resolves the matching handlers from the container and, by default, awaits them one after the other. It all happens in `SavingChangesAsync`, before EF Core writes anything, so the team the first handler adds is saved in the same transaction as the workspace. Why the dispatch sits there, and how the integration event reaches the outbox, is the subject of [Domain events vs integration events, and the transactional outbox](/blog/2026-05-28-domain-events-vs-integration-events-and-the-outbox/).

The interceptor and the publisher play the `Notify` loop that the classic `Order` carried itself.


## A handler that signals the UI
A tempting next step is a handler that pushes a real-time signal to the browser when something changes. It is fair to ask whether that turns the domain event into a UI mechanism.

The aggregate never publishes anything. It records a fact: a workspace was created, an issue was moved. What a handler does with that fact is the handler's business, and pushing a signal is one more reaction, as legitimate as creating a team or publishing an integration event. The line to watch is the event itself. `IssueMovedDomainEvent` is a domain fact that holds whether or not a screen is open. `RefreshTheBoard` would be a command to the UI wearing an event's name: the model would then know about screens, and the next consumer would have to pretend it cares about a board.

A project-management app built on the Starter does exactly this. Its board pages go live through handlers such as `SignalProjectWhenIssueMovedDomainEventHandler`, which publish a short "re-read this project" signal through the real-time port. The issue aggregate raises the same events it raised before the board was live; the signal is one more observer, added without touching it. The transport is the subject of [Server-Sent Events with ASP.NET Core and Angular](/blog/2026-09-13-server-sent-events-with-aspnet-core-and-angular/).


## What it costs
**Invisible control flow.** Reading `WorkspacesService` shows `workspace.MarkAsCreated()` and nothing about a team. "Who reacts to this?" is answered by searching for the event's name, not by following a call. The naming convention keeps that search short, but a new developer has to know to do it.

**Ordering between handlers.** The default publisher awaits the handlers in sequence, in the order the container returns them, which nobody declared. As long as handlers are independent, that is fine. The day one handler needs another's result, the dependency is real but written nowhere; at that point, the two reactions belong in one handler, or in one method the service calls.

**A failing handler fails the save.** The handlers run inside `SavingChangesAsync`. If one throws, the exception goes up through `SaveChanges`, the transaction rolls back and the workspace is not created. For the team, that is the guarantee we want. For a reaction that is optional, it is too strong: such a reaction belongs after the commit, on the bus, where a failure is retried without undoing the change.

**Events that grow into commands.** An event named after what the subscriber should do (`SendWelcomeEmail`, `RefreshTheBoard`) couples the subject to one observer again, through a name instead of a reference. An event says what happened, in the language of the domain; each handler decides what that means for it.


## When a direct method call is clearer
The pattern pays off when a fact has several independent reactions, when the reactions change more often than the subject, or when the subject must not depend on them (a domain model that cannot see the database or the bus). Creating a workspace has all three.

It does not pay off for a single reaction that is part of the use case itself. If creating a workspace always means creating its team, and nothing else ever will react, a call to `teamsRepository.AddAsync` in the service is shorter, visible, and ordered. An event with one handler, written "for later", is indirection paid now for a flexibility nobody has asked for. The same goes for an `if` or a `switch` in the service: when the reaction depends on the input and lives in one place, write it there. Introduce the event when the second observer arrives, or when the dependency would point the wrong way.


## Conclusion
The Observer pattern separates the code that changes state from the code that reacts to it. C# events, `IObservable<T>` and Angular signals are everyday versions of it, each with its own way to attach and detach. Domain events add one step: the aggregate records a fact and knows no observer, the container attaches the handlers, and a dispatcher notifies them at `SaveChanges`. In Blouppy Starter, `Workspace.MarkAsCreated()` raises one event, and two handlers create the team and announce the workspace, without either knowing the other. The price is a control flow we find by searching rather than reading, an order nobody declared, and handlers that share the fate of the save. When there is one reaction and it belongs to the use case, a method call is still the clearer choice.


## References
- [Design Patterns: Elements of Reusable Object-Oriented Software](https://en.wikipedia.org/wiki/Design_Patterns) — the Gang of Four book that catalogues the Observer pattern.
- [Observer design pattern (Microsoft Learn)](https://learn.microsoft.com/dotnet/standard/events/observer-design-pattern) — `IObservable<T>` and `IObserver<T>` in .NET.
- [Handling and raising events (Microsoft Learn)](https://learn.microsoft.com/dotnet/standard/events/) — C# events and delegates.
- [Reactive Extensions for .NET](https://github.com/dotnet/reactive) — Rx.NET, the operators on top of `IObservable<T>`.
- [Signals (Angular)](https://angular.dev/guide/signals) — `computed()` and `effect()` as observers on the front end.
- [Domain events: design and implementation (Microsoft Learn)](https://learn.microsoft.com/dotnet/architecture/microservices/microservice-ddd-cqrs-patterns/domain-events-design-implementation) — raising and dispatching domain events.
- [Domain Event](https://martinfowler.com/eaaDev/DomainEvent.html) — Martin Fowler's description of the pattern.
- [Domain events vs integration events, and the transactional outbox](/blog/2026-05-28-domain-events-vs-integration-events-and-the-outbox/) — when the handlers run, and how an integration event reaches the bus.
