---
templateKey: 'blog-post'
title: 'Domain events vs integration events in .NET, and the transactional outbox'
date: 2026-05-28T09:00:00.000Z
author: Jimmy Boinembalome
authorimage: /img/jimmy.jpg
category: C#
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

"Event" is one of the most overloaded words in a .NET code base. The same name is used for something an entity records in memory and for a message that travels through RabbitMQ to another service. Mixing the two leads to classic bugs: a message sent for a change that was rolled back, or a change committed whose message was never sent.

In this article, we will separate the two kinds of event, see how domain events are dispatched with an EF Core interceptor so that their handlers join the same transaction, and how a domain event handler turns into an integration event that goes through a transactional outbox.


## Two kinds of event, two jobs
Let's start with the definitions, because everything else follows from them:

| | Domain event | Integration event |
| --- | --- | --- |
| Raised by | An entity (`AddDomainEvent(...)`) | A domain event handler, through `IIntegrationEventPublisher<T>` |
| Handled | In the same process, inside the same transaction | By any domain or host, after the commit, through the bus |
| Handler | `IDomainEventHandler<T>` | `IIntegrationEventHandler<T>` |
| Typical use | A consequence that must commit or roll back with the change | Telling another domain, a module or another host that something happened |

A **domain event** is a consequence: "a workspace was created, so it needs a team". An **integration event** is a fact for the outside world: "a workspace was created, in case someone cares", heard later, maybe in another process.


## The dual-write problem
Before looking at the code, let's see what goes wrong when we publish a message "next to" a database write. There are only two possible orders, and both are broken:

```text:clipboard=false
Publish, then commit:   message sent ──► commit fails  ──► subscribers react to a change that never happened
Commit, then publish:   commit ok    ──► broker down    ──► change exists, nobody ever hears about it
```

There is no transaction spanning the database and the broker, and the process can crash between the two calls. The way out is to write the message **into the database**, in the same transaction as the change, and to send it from there. That is the transactional outbox, and we will get there step by step.


## Raising a domain event
The shared kernel gives aggregates a base class that collects events. Here is `HasDomainEventsBase`, from `Blouppy.SharedKernel/DomainEvents`:

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

public abstract class DomainEventBase : IDomainEvent
{
    public DateTimeOffset DateOccurred { get; } = DateTimeOffsetProvider.Now;
}
```

Here is what matters:
- `AddDomainEvent` is `protected`: only the entity itself can say what happened to it.
- Nothing is dispatched here. The entity only **records** the event.
- `ClearDomainEvents` is `internal`, so only the shared kernel's publisher can empty the list.

The event itself is a plain class in the domain's `.Models` project, with the ids a handler needs:

```csharp
public sealed class WorkspaceCreatedDomainEvent(
    WorkspaceId workspaceId,
    UserId ownerId,
    OrganizationId organizationId) : DomainEventBase
{
    public WorkspaceId WorkspaceId { get; } = workspaceId;
    public UserId OwnerId { get; } = ownerId;
    public OrganizationId OrganizationId { get; } = organizationId;
}
```

The `Workspace` entity raises it in `MarkAsCreated`, and the service calls it right after handing the entity to the repository:

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

> **_Note:_**  The order is not an accident. The workspace's key comes from a HiLo sequence, so EF Core assigns it when the entity is added. `MarkAsCreated` runs after `AddAsync`, and `ThrowIfNullOrNegativeOrZero(Id)` guarantees the event never carries an empty id.

The service does not save anything: the controller commits through `IUnitOfWork.CommitAsync`.


## Dispatching before SaveChanges
The domain events are dispatched by an EF Core interceptor, `PublishDomainEventsInterceptor` in `Blouppy.Infrastructure.Database/Interceptors`. Let's look at it:

```csharp
internal sealed class PublishDomainEventsInterceptor(
    IDomainEventPublisher domainEventPublisher) : SaveChangesInterceptor
{
    public override async ValueTask<InterceptionResult<int>> SavingChangesAsync(DbContextEventData eventData, InterceptionResult<int> result, CancellationToken cancellationToken = default)
    {
        // A. Right BEFORE committing data (EF SaveChanges) into the DB will make a single transaction including  
        // side effects from the domain event handlers which are using the same DbContext with "scoped" lifetime
        // B. Right AFTER committing data (EF SaveChanges) into the DB will make multiple transactions. 
        // You will need to handle eventual consistency and compensatory actions in case of failures in any of the Handlers. 
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

The comment says it all. The interceptor overrides `SavingChangesAsync`, which runs **before** EF Core writes anything. Every handler resolves the same scoped `DbContext`, so whatever a handler adds to it is written by the very `SaveChanges` that is about to run. Option B (after the save) would mean several transactions, and compensating actions when a handler fails. Option A gives us one transaction for free.

The `DomainEventPublisher` takes a copy of each entity's events, clears the list, and publishes them one by one:

```csharp
foreach (var entity in entities)
{
    var domainEvents = entity.DomainEvents.ToArray();
    
    entity.ClearDomainEvents();
    
    foreach (var domainEvent in domainEvents)
    {
        await publisher.PublishAsync(domainEvent, cancellationToken);
    }
}
```

Clearing before publishing means a second `SaveChanges` on the same context will not dispatch the same events twice.

And here is `UnitOfWork.CommitAsync`, which opens the transaction around that save:

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

The explicit transaction matters: the outbox waits for its commit, as we will see.


## A handler that writes in the same transaction
Now, the consequence. Here is `CreateTeamWhenWorkspaceCreatedDomainEventHandler`, in `Blouppy.Workspaces/Teams/DomainEventHandlers`:

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

The handler only **adds** the team to the repository; it never saves. The workspace row and the team row are written by the same `SaveChanges`, in the same transaction: they commit together, or neither does. 👍

This is the right use of a domain event: a rule inside one domain, that must be consistent with the change.


## From a domain event to an integration event
The Webhooks module also wants to know that a workspace was created, so it can notify the organization's endpoints. But a domain never calls another domain to tell it something. It publishes an integration event, **from a domain event handler**:

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

A few things to notice:
- It handles the **same** domain event as the team handler. A domain event can have as many handlers as it needs.
- The integration event is a separate type, `WorkspaceCreatedIntegrationEvent`, a `sealed record` in `Blouppy.Infrastructure.Messaging.Abstractions/Workspaces`. The domain event never leaves the process: what crosses the boundary is a contract of its own, with only ids.
- The handler depends on `IIntegrationEventPublisher<T>`, a port. It does not know which bus is behind it.

Because this handler runs inside `SavingChangesAsync`, the publish happens **during** the unit of work, before anything is written. That is exactly where an outbox can catch it.

On the other side, `DispatchWebhooksWhenWorkspaceCreatedIntegrationEventHandler` implements `IIntegrationEventHandler<WorkspaceCreatedIntegrationEvent>` in the Webhooks module, and runs after the commit, whenever the message is delivered.


## The outbox: the event exists if and only if the change committed
Behind `IIntegrationEventPublisher<T>`, the messaging adapter does not send anything to the broker. It adds the message, as an envelope row, to the **same** `DbContext`. Those rows are written by the same `SaveChanges` as the workspace and the team.

The adapter then watches the transaction with an EF Core interceptor (`OutboxInterceptor<TDbContext>`, a `SaveChangesInterceptor` and an `IDbTransactionInterceptor`), and keeps the batches in a scoped `OutboxSession<TDbContext>`. Here is the part that teaches, slightly trimmed:

```csharp
public async Task SavedAsync(Guid? transactionId)
{
    // ...
    if (transactionId is null)
    {
        // Saved in a transaction of the save's own, already committed.
        await FlushAsync(batch);

        return;
    }

    _awaitingCommit.Add((transactionId.Value, batch));
}

public async Task CommittedAsync(Guid transactionId)
{
    // Flushes every batch saved in that transaction.
}

public void RolledBack(Guid transactionId)
    => _awaitingCommit.RemoveAll(x => x.TransactionId == transactionId);
```

Here is the sequence:
- `SaveChanges` writes the envelope rows with the business rows. The batch then waits for the transaction it was saved in.
- When the transaction **commits**, the batch is flushed to the broker.
- When it **rolls back**, the batch is dropped. The rows were never committed either, so there is nothing to send. 😉
- If the broker is down at commit time, the flush fails, but the rows are committed: the bus library's durability agent sends them later.

That last point has a subtle detail worth quoting. `FlushAsync` never throws:

```csharp
/// <summary>
/// Never throws: the rows are committed by now, so a failure surfacing here would have the unit of work retry a
/// commit that succeeded. The rows stay in the outbox, where Wolverine's durability agent sends them.
/// </summary>
```

Back to our two broken orders: a failed commit takes the envelope row with it, and a broker down at commit time only delays the send. The integration event now exists **if and only if** the change did. The audit log relies on exactly that.

> **_Note:_**  The outbox guarantees the message is sent, not that it is handled once: a handler that fails is retried, so integration event handlers must be idempotent. [Idempotent message handlers](https://www.blouppy.com/blog/2026-08-20-idempotent-message-handlers-with-deterministic-ids/) covers how, and [Replacing MassTransit with Wolverine](https://www.blouppy.com/blog/2026-06-09-replacing-masstransit-with-wolverine/) covers the bus adapter itself.


## What it costs
This design is not free, and it is better to know it upfront:
- **The commit carries more work.** Domain event handlers run inside `SaveChanges`. A slow handler slows down the request, so a domain event handler is best kept to adding rows or publishing.
- **Two event types per fact that crosses a boundary**, plus a small handler between them: the price of keeping the domain model out of the contract.
- **Eventual consistency on the other side.** The Webhooks module learns about the workspace after the commit, not during it. Anything that must be consistent with the change belongs in a domain event handler, not an integration one.


## Conclusion
Domain events and integration events are not two names for the same thing. A domain event is recorded by an entity and handled in process, inside the transaction, through `IDomainEventHandler<T>`. An integration event is a separate contract, published from a domain event handler through `IIntegrationEventPublisher<T>`, and handled after the commit, by whoever subscribed.

Dispatching domain events in `SavingChangesAsync` is what puts the handlers' writes in the same transaction, and putting the outbox rows in the same `DbContext` is what makes an integration event exist if and only if the change committed. No more dual write, no more ghost messages.

This is how events are built in [Blouppy Starter](https://starter.blouppy.com/): domain events dispatched by an EF Core interceptor, integration events through an outbox on PostgreSQL. The [messaging documentation](https://docs.starter.blouppy.com/architecture/messaging/) walks through the same flow.

*Thanks for reading! 🙂*
