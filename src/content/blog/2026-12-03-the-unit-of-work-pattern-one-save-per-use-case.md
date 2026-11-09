---
templateKey: 'blog-post'
title: 'The Unit of Work pattern: one save per use case'
date: 2026-12-03T09:00:00.000Z
author: Jimmy Boinembalome
authorimage: /img/jimmy.jpg
category: C#
topic: 'Architecture'
illustration: 2
categorycolor: bg-purple-100 text-purple-800
featuredpost: true
description: >-
  Learn the Unit of Work pattern in .NET: why EF Core's DbContext already is one, when to wrap it in a port, and what one commit does, from domain events to the outbox.
tags:
  - Development
  - C#
  - Design Patterns
  - DDD
  - EF Core
---

A use case rarely changes one row. Creating a workspace also creates its first team, stamps who did it and writes a message for the other modules. When each repository saves its own changes, a failure halfway leaves a workspace without a team, or a message announcing a workspace that was never committed.

The Unit of Work pattern writes all of it at once, or none of it.


## EF Core already is one
The pattern comes from Martin Fowler's *Patterns of Enterprise Application Architecture*. A unit of work "maintains a list of objects affected by a business transaction and coordinates the writing out of changes". It tracks what was added, changed and removed. It commits all of it in one transaction. And it refuses to overwrite a row someone else changed in the meantime.

With EF Core, we never write that class. The change tracker is the list of affected objects. `SaveChangesAsync` is the commit, wrapped in a transaction of its own. Concurrency tokens make it throw `DbUpdateConcurrencyException` on a conflict. So the question is never how to implement a unit of work in EF Core. It is whether to hide the one we already have behind an interface.


## Why wrap it in a port
In a [hexagonal architecture](/blog/2026-05-04-hexagonal-architecture-in-dotnet/), the domain must not reference EF Core. A domain that needs to commit asks a port instead. [Blouppy Starter](https://starter.blouppy.com/) declares it next to the repositories. Simplified:

```csharp
public interface IUnitOfWork
{
    Task CommitAsync(CancellationToken cancellationToken = default);

    void DiscardChanges();
}
```

There is no `RegisterNew`: the change tracker does that through the repositories. `DiscardChanges` clears the tracker, so a failure can be recorded without what the failed work left half done. Two more overloads of `CommitAsync` run extra work inside the same transaction; we will meet one below.

The port gives two more things. A commit becomes a word in the code: we can search for it, and see that it is called once per use case. And repositories never save. They stage changes, and whoever owns the use case decides whether they are written.


## The service stages, the controller commits
`WorkspacesService.TryAddAsync` validates, builds the `Workspace`, adds it to the repository and records a domain event on it. Nothing is written yet. The controller commits, and only on success:

```csharp
var result = await workspacesService.TryAddAsync(workspaceCreation, cancellationToken);

return await result.MatchAsync(
    onSuccess: async workspace =>
    {
        await unitOfWork.CommitAsync(cancellationToken);

        var dto = await workspaceDtoFactory.CreateAsync(workspace, cancellationToken);

        return CreatedAtRoute(RouteNames.Api.Workspaces.Get, new { id = dto.Id }, dto);
    },
    onFailed: BadRequest);
```

A refused request commits nothing, so it writes nothing. Outside HTTP, an integration event handler that changes rows ends with its own `CommitAsync`.


## Inside the commit
The implementation is short. Simplified:

```csharp
public async Task CommitAsync(CancellationToken cancellationToken = default)
{
    var strategy = dbContext.Database.CreateExecutionStrategy();

    await strategy.ExecuteAsync(async () =>
    {
        await using var transaction = await dbContext.Database.BeginTransactionAsync(IsolationLevel.ReadCommitted, cancellationToken);

        await dbContext.SaveChangesAsync(cancellationToken);

        await transaction.CommitAsync(cancellationToken);
    });
}
```

The execution strategy wraps everything because, with retries on, EF Core refuses a transaction we open ourselves outside `ExecuteAsync`. A transient failure then replays the block as one unit. The transaction is explicit because the outbox waits for its commit.

Most of the work hides in EF Core [interceptors](https://learn.microsoft.com/ef/core/logging-events-diagnostics/interceptors), before the save. The domain events are dispatched first. A handler that adds the first team adds it to the same change tracker, and a handler that publishes `WorkspaceCreatedIntegrationEvent` adds an outbox row to it. Then two interceptors stamp who created or modified each entity, the new team included. EF Core writes the workspace, the team and the outbox row in one batch, and the message reaches RabbitMQ only once the transaction commits. If anything throws, nothing is written and nothing is sent. The [outbox article](/blog/2026-05-28-domain-events-vs-integration-events-and-the-outbox/) covers that part in detail.


## Two contexts, one transaction
The Billing module has its own `BillingDbContext`, in its own schema, but no outbox: the bus writes through the application's context. Committing the billing context alone would write a subscription and lose the message it publishes. So `BillingUnitOfWork` calls the application's `CommitAsync` with a callback. Inside it, the billing context borrows the application's connection and transaction, then saves first, so that its outbox rows exist before the application's context saves.

That works only because both contexts point at the same PostgreSQL database: a transaction belongs to one connection. With two databases, the usual answer is an outbox in each, and eventual consistency between them.


## Pitfalls
- **`SaveChangesAsync` inside a repository.** The next repository runs after a commit it cannot undo. In the Starter's database adapter, the one repository that saves is the account erasure's, which runs as a transaction of its own.
- **Several saves in one use case.** The second can fail after the first committed. If we need an ID before the end, a [HiLo sequence](/blog/2026-05-16-strongly-typed-ids-with-ef-core/) gives it on `Add`, without a save.
- **Set-based statements.** `ExecuteUpdateAsync` and `ExecuteDeleteAsync` run immediately and bypass the change tracker. They join the unit of work only when a transaction is already open.
- **A forgotten commit.** Nothing fails. The scope ends, the context is disposed, and the changes are lost silently. An integration test that reads the row back with another context is the only guard.


## When not to bother
The port earns its place when the code that commits must not know EF Core, and when the commit coordinates something: interceptors, an outbox, a second context. Without those, it is an extra name for `SaveChangesAsync`. An endpoint that injects the `DbContext`, changes an entity and saves already uses a unit of work, transaction included.

The port has a cost too. The commit lives far from the changes, in the controller, so a reader must know the convention to see where data is written. And since interceptors do most of the work, one `CommitAsync` line can run handlers we did not write.


## References
- [Unit of Work (Martin Fowler)](https://martinfowler.com/eaaCatalog/unitOfWork.html) — the pattern's entry in the catalog.
- [Using Transactions (Microsoft Learn)](https://learn.microsoft.com/ef/core/saving/transactions) — explicit transactions and sharing one across contexts.
- [Connection Resiliency (Microsoft Learn)](https://learn.microsoft.com/ef/core/miscellaneous/connection-resiliency) — execution strategies and user-initiated transactions.
- [Domain events vs integration events in .NET, and the transactional outbox](/blog/2026-05-28-domain-events-vs-integration-events-and-the-outbox/) — the dispatch and the outbox this commit relies on.
