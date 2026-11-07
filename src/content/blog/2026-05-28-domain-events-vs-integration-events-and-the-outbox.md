---
templateKey: 'blog-post'
title: 'Domain events vs integration events in .NET, and the transactional outbox'
date: 2026-05-28T09:00:00.000Z
updated: 2026-11-07T09:00:00.000Z
author: Jimmy Boinembalome
authorimage: /img/jimmy.jpg
category: C#
topic: 'Messaging'
illustration: 1
categorycolor: bg-purple-100 text-purple-800
featuredpost: true
featuredimage: /img/domain-events-vs-integration-events-and-the-outbox.jpg
description: >-
  Learn the difference between domain events and integration events in .NET, and how a transactional outbox on EF Core and PostgreSQL makes an event exist if and only if the change committed.
tags:
  - Development
  - C#
  - ASP.NET Core
  - EF Core
  - PostgreSQL
  - Architecture
---

"Event" is one of the most overloaded words in a .NET code base. The same name covers something an entity records in memory and a message that travels through RabbitMQ to another service. Mixing the two leads to classic bugs: a message sent for a change that was rolled back, or a committed change whose message was never sent.

In this article, we separate the two kinds of event, dispatch domain events with an EF Core interceptor so that their handlers join the same transaction, and turn a domain event into an integration event that goes through a transactional outbox.


## Two kinds of event, two jobs

| | Domain event | Integration event |
| --- | --- | --- |
| Raised by | An entity (`AddDomainEvent(...)`) | A domain event handler, through `IIntegrationEventPublisher<T>` |
| Handled | In the same process, inside the same transaction | By any domain or host, after the commit, through the bus |
| Handler | `IDomainEventHandler<T>` | `IIntegrationEventHandler<T>` |
| Typical use | A consequence that must commit or roll back with the change | Telling another domain, a module or another host that something happened |

A [domain event](https://learn.microsoft.com/dotnet/architecture/microservices/microservice-ddd-cqrs-patterns/domain-events-design-implementation) is a consequence: "a workspace was created, so it needs a team". An [integration event](https://learn.microsoft.com/dotnet/architecture/microservices/multi-container-microservice-net-applications/subscribe-events) is a fact for the outside world: "a workspace was created, in case someone cares", heard later, maybe in another process.


## The dual-write problem
Publishing a message "next to" a database write has only two possible orders, and both are broken:

```text:clipboard=false
Publish, then commit:   message sent ──► commit fails  ──► subscribers react to a change that never happened
Commit, then publish:   commit ok    ──► broker down    ──► change exists, nobody ever hears about it
```

No transaction spans the database and the broker, and the process can crash between the two calls. The way out is to write the message **into the database**, in the same transaction as the change, and send it from there: the [transactional outbox](https://microservices.io/patterns/data/transactional-outbox.html).


## Raising a domain event
The shared kernel gives aggregates a base class that collects events:

```csharp
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

- `AddDomainEvent` is `protected`: only the entity can say what happened to it.
- Nothing is dispatched here: the entity only **records** the event.
- `ClearDomainEvents` is `internal`, so only the shared kernel's publisher can empty the list.

The event is a plain class in the domain's `.Models` project, deriving from `DomainEventBase` (which stamps `DateOccurred`) and carrying the IDs a handler needs: `WorkspaceCreatedDomainEvent(WorkspaceId, UserId ownerId, OrganizationId)`. The `Workspace` entity raises it, and the service calls it right after handing the entity to the repository:

```csharp
// Workspace.cs
public void MarkAsCreated()
    => AddDomainEvent(new WorkspaceCreatedDomainEvent(
        workspaceId: Exceptions.ThrowIfNullOrNegativeOrZero(Id),
        ownerId: Exceptions.ThrowIfNullOrWhiteSpace(ownerId),
        organizationId: OrganizationId));

// WorkspacesService.TryAddAsync
await workspacesRepository.AddAsync(workspace, cancellationToken);

workspace.MarkAsCreated();

return ValidationResult.Success(workspace);
```

The order matters. The workspace's key comes from a HiLo sequence, so EF Core assigns it when the entity is added; `MarkAsCreated` runs after `AddAsync`, and `ThrowIfNullOrNegativeOrZero(Id)` guarantees the event never carries an empty ID. The service saves nothing: the controller commits through `IUnitOfWork.CommitAsync`.


## Dispatching before SaveChanges
An EF Core [interceptor](https://learn.microsoft.com/ef/core/logging-events-diagnostics/interceptors) dispatches the domain events (comment abridged):

```csharp
internal sealed class PublishDomainEventsInterceptor(
    IDomainEventPublisher domainEventPublisher) : SaveChangesInterceptor
{
    public override async ValueTask<InterceptionResult<int>> SavingChangesAsync(DbContextEventData eventData, InterceptionResult<int> result, CancellationToken cancellationToken = default)
    {
        // A. Right BEFORE SaveChanges: a single transaction including the side effects of the domain event handlers,
        // which use the same scoped DbContext.
        // B. Right AFTER SaveChanges: multiple transactions, with eventual consistency and compensatory actions.
        await PublishDomainEventsAsync(eventData.Context, cancellationToken);

        return await base.SavingChangesAsync(eventData, result, cancellationToken);
    }

    private async Task PublishDomainEventsAsync(DbContext? context, CancellationToken cancellationToken)
    {
        if (context is null) return;

        var entities = context.ChangeTracker
            .Entries<HasDomainEventsBase>()
            .Where(x => x.Entity.DomainEvents.Count > 0)
            .Select(x => x.Entity)
            .ToList();

        await domainEventPublisher.PublishAsync(entities, cancellationToken);
    }
}
```

`SavingChangesAsync` runs **before** EF Core writes anything. Every handler resolves the same scoped `DbContext`, so whatever a handler adds is written by the very `SaveChanges` about to run: one transaction for free. The publisher copies each entity's events and clears the list **before** publishing them, so a second `SaveChanges` on the same context does not dispatch them twice.

`UnitOfWork.CommitAsync` opens an explicit [transaction](https://learn.microsoft.com/ef/core/saving/transactions) around that save, inside the provider's [execution strategy](https://learn.microsoft.com/ef/core/miscellaneous/connection-resiliency):

```csharp
await strategy.ExecuteAsync(async () =>
{
    await using var transaction = await BeginTransactionAsync(cancellationToken);

    // Save the entities (domain events are published before the save)
    await dbContext.SaveChangesAsync(cancellationToken);

    // Commit all changes
    await transaction.CommitAsync(cancellationToken);
});
```

The explicit transaction matters: the outbox waits for its commit.


## A handler that writes in the same transaction
Here is the consequence, in `Blouppy.Workspaces/Teams/DomainEventHandlers`:

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

The handler only **adds** the team; it never saves. The workspace and the team are written by the same `SaveChanges`, in the same transaction: they commit together, or neither does. That is the right use of a domain event: a rule inside one domain that must stay consistent with the change.


## From a domain event to an integration event
The Webhooks module also wants to know that a workspace was created, to notify the organization's endpoints. A domain never calls another domain to tell it something: it publishes an integration event, **from a domain event handler**:

```csharp
/// <summary>
/// Announces the new workspace through the outbox of the transaction that creates it, so that a subscriber
/// hears of it only once the workspace exists.
/// </summary>
internal sealed class PublishIntegrationEventWhenWorkspaceCreatedDomainEventHandler(
    IIntegrationEventPublisher<WorkspaceCreatedIntegrationEvent> integrationEventPublisher)
    : IDomainEventHandler<WorkspaceCreatedDomainEvent>
{
    public async Task HandleAsync(WorkspaceCreatedDomainEvent @event, CancellationToken cancellationToken)
        => await integrationEventPublisher.PublishAsync(
            new WorkspaceCreatedIntegrationEvent(
                @event.OrganizationId,
                @event.WorkspaceId,
                @event.OwnerId),
            cancellationToken);
}
```

- It handles the **same** domain event as the team handler: a domain event can have as many handlers as it needs.
- `WorkspaceCreatedIntegrationEvent` is a separate `sealed record` in `Blouppy.Infrastructure.Messaging.Abstractions`. The domain event never leaves the process; what crosses the boundary is a contract of its own, with IDs only.
- The handler depends on `IIntegrationEventPublisher<T>`, a port, and does not know which bus is behind it.

Because this handler runs inside `SavingChangesAsync`, the publish happens **during** the unit of work, before anything is written: exactly where an outbox can catch it. On the other side, the Webhooks module's `DispatchWebhooksWhenWorkspaceCreatedIntegrationEventHandler` runs after the commit, whenever the message is delivered.


## The outbox: the event exists if and only if the change committed
Behind `IIntegrationEventPublisher<T>`, the messaging adapter sends nothing to the broker. It adds the message, as an envelope row, to the **same** `DbContext`, so the same `SaveChanges` writes it with the workspace and the team.

The adapter watches the transaction with `OutboxInterceptor<TDbContext>`, both a `SaveChangesInterceptor` and an `IDbTransactionInterceptor`, and keeps the batches in a scoped `OutboxSession<TDbContext>`:

- After `SaveChanges`, `SavedAsync(transactionId)` parks the batch until the transaction it was saved in ends.
- When that transaction **commits**, `CommittedAsync` flushes the batch to the broker.
- When it **rolls back**, `RolledBack` drops the batch. The rows were never committed either, so there is nothing to send.
- If the broker is down at commit time, the flush fails but the rows are committed, and [Wolverine's durability agent](https://wolverinefx.net/guide/durability/) sends them later.

That is why `FlushAsync` catches and logs every exception instead of throwing: the rows are committed by then, and a failure surfacing there would make the unit of work retry a commit that succeeded.

Back to the two broken orders: a failed commit takes the envelope row with it, and a broker down at commit time only delays the send. The integration event now exists **if and only if** the change did, which the audit log relies on.

> **_Note:_** The outbox guarantees the message is sent, not that it is handled once: a failing handler is retried, so integration event handlers must be idempotent. See [Idempotent message handlers](https://www.blouppy.com/blog/2026-08-20-idempotent-message-handlers-with-deterministic-ids/), and [Replacing MassTransit with Wolverine](https://www.blouppy.com/blog/2026-06-09-replacing-masstransit-with-wolverine/) for the bus adapter itself.


## What it costs
- **The commit carries more work.** Domain event handlers run inside `SaveChanges`, so a slow handler slows the request. Keep them to adding rows or publishing.
- **Two event types per fact that crosses a boundary**, plus a small handler between them: the price of keeping the domain model out of the contract.
- **Eventual consistency on the other side.** The Webhooks module learns about the workspace after the commit. Anything that must be consistent with the change belongs in a domain event handler.


## Conclusion
A domain event is recorded by an entity and handled in process, inside the transaction. An integration event is a separate contract, published from a domain event handler and handled after the commit by whoever subscribed. Dispatching domain events in `SavingChangesAsync` puts the handlers' writes in the same transaction, and writing the outbox rows to the same `DbContext` makes an integration event exist if and only if the change committed.

Events in [Blouppy Starter](https://starter.blouppy.com/) are built this way, with the outbox on PostgreSQL.


## References

- [Domain events: design and implementation](https://learn.microsoft.com/dotnet/architecture/microservices/microservice-ddd-cqrs-patterns/domain-events-design-implementation) — Microsoft Learn: raising and dispatching domain events.
- [Implementing event-based communication](https://learn.microsoft.com/dotnet/architecture/microservices/multi-container-microservice-net-applications/subscribe-events) — Microsoft Learn: integration events and the dual-write problem.
- [Interceptors](https://learn.microsoft.com/ef/core/logging-events-diagnostics/interceptors) — EF Core documentation: `SaveChangesInterceptor` and transaction interceptors.
- [Using transactions](https://learn.microsoft.com/ef/core/saving/transactions) and [Connection resiliency](https://learn.microsoft.com/ef/core/miscellaneous/connection-resiliency) — EF Core documentation: explicit transactions inside an execution strategy.
- [Transactional outbox](https://microservices.io/patterns/data/transactional-outbox.html) — the pattern, by Chris Richardson.
- [Wolverine durable messaging](https://wolverinefx.net/guide/durability/) and [EF Core integration](https://wolverinefx.net/guide/durability/efcore/) — the outbox and its durability agent.
- [Domain Event](https://martinfowler.com/eaaDev/DomainEvent.html) — Martin Fowler's description of the pattern.
- [Messaging in Blouppy Starter](https://docs.starter.blouppy.com/architecture/messaging/) — the same flow in the Starter's documentation.
