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

When a workspace is created, several things follow. It needs a first team with its owner in it. The audit log and the organization's webhooks need to hear about it. The simplest code calls each of them from the service that creates the workspace. Every new reaction then means editing that service, and the service ends up depending on everything that cares about workspaces.

The Observer pattern turns that around.


## The classic shape
The Observer pattern is one of the Gang of Four's behavioral patterns. When one object changes state, its dependents are notified, and the object does not know who they are. The object that changes is the **subject**. The dependents are the **observers**.

```csharp
public interface IOrderObserver
{
    void Update(Order order);
}

public sealed class Order
{
    private readonly List<IOrderObserver> _observers = [];

    public void Attach(IOrderObserver observer) => _observers.Add(observer);

    public void Submit()
    {
        Status = "Submitted";

        foreach (var observer in _observers)
        {
            observer.Update(this);
        }
    }

    public string Status { get; private set; } = "Draft";
}
```

`Order` depends on one interface, never on a concrete observer. A new reaction is a new class; `Order` does not change.

.NET developers use this shape every day. A C# `event` is the pattern built into the language: `+=` attaches, `-=` detaches. Its known trap is the leak: a long-lived subject keeps every subscriber alive until it unsubscribes. `IObservable<T>` and RxJS subjects are the same idea for streams of values, and Angular's `computed()` observes the signals it reads. In all of them, the observers run in the same process, while the subject changes. That is the difference with integration events on a bus, which run later, elsewhere, and maybe twice.


## The subject records a fact
A domain model should not keep a list of observers: it would have to know about the container, the database or the bus. So in [Blouppy Starter](https://starter.blouppy.com/), the aggregate keeps a list of **events** instead. It only says what happened, and someone else delivers it.

```csharp
public abstract class HasDomainEventsBase
{
    private readonly List<IDomainEvent> _domainEvents = [];

    public IReadOnlyCollection<IDomainEvent> DomainEvents => _domainEvents.AsReadOnly();

    protected void AddDomainEvent(IDomainEvent domainEvent) => _domainEvents.Add(domainEvent);
}

public sealed class Workspace : HasDomainEventsBase
{
    public void MarkAsCreated()
        => AddDomainEvent(new WorkspaceCreatedDomainEvent(Id, OwnerId, OrganizationId));
}
```

This is simplified: the real `Workspace` derives from an auditable base class and checks its ids before raising the event. The point holds. There is no `Attach` and no `Notify`. `Workspace` lives in a project with no reference to anything technical, so it could not call an observer even if it wanted to.


## The observers are handlers
An observer is a class implementing `IDomainEventHandler<TEvent>`. Two of them observe `WorkspaceCreatedDomainEvent`. The first creates the team:

```csharp
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

The second publishes a `WorkspaceCreatedIntegrationEvent` for the modules that listen on the bus. Neither knows the other exists, and `Workspace` knows neither. The `<Action>When<Event>` name means a file search on the event lists every reaction to it.

The container does the attaching. Each domain calls `AddBlouppyEvents` with its own assembly, which registers every handler it finds. Adding an observer is adding a class. The flip side: forget that call and nothing breaks at build time; the domain just stops reacting.

The `Notify` loop lives in an EF Core `SaveChangesInterceptor`. Before EF Core writes anything, it collects the events of the tracked entities, clears them, and hands each one to a publisher that awaits its handlers in turn. So the team is saved in the same transaction as the workspace. [Domain events vs integration events, and the transactional outbox](/blog/2026-05-28-domain-events-vs-integration-events-and-the-outbox/) explains why the dispatch sits there.

A project-management app built on the Starter uses the same mechanism for live boards. A handler such as `SignalProjectWhenIssueMovedDomainEventHandler` pushes a short "re-read this project" signal to the browser. The issue raises the same events it did before; the signal is one more observer. What keeps that clean is the event's name. `IssueMoved` is a fact of the domain. `RefreshTheBoard` would be a command to the UI wearing an event's name.


## The price
**The control flow is invisible.** Reading the service shows `workspace.MarkAsCreated()` and nothing about a team. "Who reacts to this?" is answered by a search, not by following a call.

**Nobody declared the order.** Handlers run in the order the container returns them. That is fine while they are independent. The day one needs another's result, they belong in one handler.

**A failing handler fails the save.** Handlers run inside `SaveChanges`. If one throws, the transaction rolls back and the workspace is not created. For the team, that is the guarantee we want. For an optional reaction, it is too strong: that one belongs on the bus, after the commit, where a failure is retried.


## When a method call is clearer
The pattern pays off when a fact has several independent reactions, or when the subject must not depend on them. Creating a workspace has both.

For a single reaction that is part of the use case, a call in the service is shorter, visible and ordered. An event with one handler, written "for later", is indirection paid now for a flexibility nobody asked for. Introduce the event when the second observer arrives, or when the dependency would point the wrong way.


## References
- [Observer design pattern](https://learn.microsoft.com/dotnet/standard/events/observer-design-pattern) — Microsoft Learn: `IObservable<T>` and `IObserver<T>` in .NET.
- [Domain events: design and implementation](https://learn.microsoft.com/dotnet/architecture/microservices/microservice-ddd-cqrs-patterns/domain-events-design-implementation) — Microsoft Learn: raising and dispatching domain events.
- [Domain Event](https://martinfowler.com/eaaDev/DomainEvent.html) — Martin Fowler's description of the pattern.
- [Domain events vs integration events, and the transactional outbox](/blog/2026-05-28-domain-events-vs-integration-events-and-the-outbox/) — when the handlers run, and how an integration event reaches the bus.
