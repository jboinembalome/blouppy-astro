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

In this article, we will look at the **Unit of Work** pattern: its definition, why EF Core's `DbContext` already implements it, and why [Blouppy Starter](https://starter.blouppy.com/) still puts it behind an `IUnitOfWork` port. We will follow one commit step by step, see how a module with its own `DbContext` joins the same transaction, then go through the pitfalls and the cases where calling `SaveChangesAsync` directly is enough.


## The pattern
The Unit of Work comes from Martin Fowler's *Patterns of Enterprise Application Architecture*, where it sits among the object-relational behavioral patterns. It is not a Gang of Four pattern. Fowler's definition: it "maintains a list of objects affected by a business transaction and coordinates the writing out of changes and the resolution of concurrency problems."

Three jobs come out of that sentence:

- **Track.** Remember what was added, changed and removed while the use case runs.
- **Commit.** Write all of it at the end, in one transaction, in an order the database accepts.
- **Detect conflicts.** Refuse to overwrite a row someone else changed in the meantime.

Written by hand, the shape looks like this:

```csharp
public interface IUnitOfWork
{
    void RegisterNew(object entity);

    void RegisterDirty(object entity);

    void RegisterRemoved(object entity);

    Task CommitAsync(CancellationToken cancellationToken = default);
}
```

The repositories register, the use case ends, and one call writes everything. Nobody in between touches the database.


## EF Core already is one
With EF Core, we never write that class. The `DbContext` documentation says it plainly: a `DbContext` instance represents a combination of the Unit of Work and Repository patterns.

- The **change tracker** is the list of affected objects. `Add`, `Remove` and loading an entity register it; changes to a tracked entity are detected on save.
- **`SaveChangesAsync`** is the commit. Unless a transaction is already open, it wraps all its statements in one transaction of its own.
- **Concurrency tokens** resolve conflicts: a mismatch makes `SaveChangesAsync` throw `DbUpdateConcurrencyException`.

So the question is never how to implement a unit of work in EF Core. It is whether to hide the one we already have behind an interface.


## Why wrap it in a port
In a [hexagonal architecture](/blog/2026-05-04-hexagonal-architecture-in-dotnet/), three reasons make the wrapper worth its few lines.

- **The domain must not reference EF Core.** `Blouppy.Workspaces` knows `IWorkspacesRepository` and nothing about `DbContext`. A domain that needs to commit asks a port declared in `Blouppy.Infrastructure.Database.Abstractions`, and the architecture tests fail the build if it reaches for the adapter.
- **One explicit commit point per use case.** `CommitAsync` is a word in the code. We can search for it, review where it is called and see that it is called once.
- **Repositories never save.** A repository stages changes. Whether they are written is decided by whoever owns the use case, which keeps several repositories in one transaction without any of them knowing about the others.

Here is the port in the Starter:

```csharp
namespace Blouppy.Infrastructure.Database.Abstractions;

public interface IUnitOfWork
{
    Task CommitAsync(CancellationToken cancellationToken = default);

    Task CommitAsync(Func<Task> funcTask, CancellationToken cancellationToken = default);

    Task CommitAsync(Func<DbTransaction, CancellationToken, Task> alongside, CancellationToken cancellationToken = default);

    void DiscardChanges();
}
```

There is no `RegisterNew`: the change tracker does that through the repositories. The first overload is the common one. The second runs work inside the transaction before the save. The third lets another context write on the same transaction, which we will come back to. `DiscardChanges` clears the change tracker, so a failure can be recorded without what the failed work left half done.


## The service stages, the controller commits
`WorkspacesService.TryAddAsync`, trimmed, never saves:

```csharp
internal sealed class WorkspacesService(
    IWorkspacesRepository workspacesRepository,
    IValidator<WorkspaceCreation> workspaceCreationValidator,
    ICurrentUserService currentUserService) : IWorkspacesService
{
    public async Task<ValidationResult<Workspace>> TryAddAsync(
        WorkspaceCreation workspaceCreation,
        CancellationToken cancellationToken = default)
    {
        // Validation trimmed.
        var workspace = new Workspace(
            name: workspaceCreation.Name,
            colour: workspaceCreation.Colour,
            ownerId: currentUserService.UserId,
            organizationId: workspaceCreation.OrganizationId);

        await workspacesRepository.AddAsync(workspace, cancellationToken);

        workspace.MarkAsCreated();

        return ValidationResult.Success(workspace);
    }
}
```

The repository's `AddAsync` only calls `dbContext.Workspaces.AddAsync`, and `MarkAsCreated` records a domain event on the entity. Nothing is written yet. The controller commits, and only on success:

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

A refused request commits nothing, so it writes nothing. The same rule holds outside HTTP: an integration event handler that changes rows ends with its own `CommitAsync`, and inside the Billing module the application services call the commit themselves.


## What happens inside the commit
`UnitOfWork.CommitAsync` is short:

```csharp
internal sealed class UnitOfWork(
    BlouppyDbContext dbContext) : IUnitOfWork
{
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
}
```

The short code hides most of the work, which runs in EF Core [interceptors](https://learn.microsoft.com/ef/core/logging-events-diagnostics/interceptors). In order:

1. **The execution strategy wraps everything.** With a retrying strategy, EF Core refuses a transaction we open ourselves unless the whole block goes through `ExecuteAsync`, so a transient failure replays the block as one unit.
2. **The transaction opens**, read committed, explicitly. The outbox needs it: it waits for this transaction's commit.
3. **`SavingChangesAsync` runs the interceptors**, registered in this order:
   - `PublishDomainEventsInterceptor` dispatches the domain events. A handler that adds a team adds it to the same change tracker; a handler that publishes `WorkspaceCreatedIntegrationEvent` adds an outbox row to it.
   - `CreatedEntityInterceptor` sets `CreatedBy` and `CreatedDate` on every added `ICreatedAtEntity` that has none.
   - `ModifiedEntityInterceptor` sets `LastModifiedBy` and `LastModifiedDate` on every modified `IModifiedAtEntity`.

   Because the domain events run first, the team a handler added is stamped like the workspace.
4. **EF Core writes the rows**: the workspace, the team and the outbox envelope, in one batch. A concurrency token, when the entity has one, goes into the `WHERE` clause of each `UPDATE`.
5. **`SavedChangesAsync`** tells the outbox session that its batch was saved in this transaction. Nothing is sent yet.
6. **The transaction commits**, and the outbox interceptor, also an `IDbTransactionInterceptor`, flushes the batch to RabbitMQ.

If any step throws, the transaction is disposed without a commit: the rows are gone, and the outbox batch is never sent. The [domain events and outbox article](/blog/2026-05-28-domain-events-vs-integration-events-and-the-outbox/) covers steps 3 and 6 in detail, and the [xmin article](/blog/2026-08-02-optimistic-concurrency-with-postgresql-xmin-in-ef-core/) covers step 4's concurrency check. What the Unit of Work adds is that all six happen **once per use case**.


## Two contexts, one transaction
The Billing module has its own `BillingDbContext`, in its own schema, but no outbox: the bus writes its envelopes through `BlouppyDbContext`. Committing the billing context alone would write a subscription and lose the message its domain events publish. `BillingUnitOfWork` solves it by borrowing the application's connection and transaction:

```csharp
internal sealed class BillingUnitOfWork(
    BillingDbContext dbContext,
    IUnitOfWork unitOfWork) : IBillingUnitOfWork
{
    public async Task CommitAsync(CancellationToken cancellationToken = default)
    {
        try
        {
            await unitOfWork.CommitAsync(
                async (transaction, token) =>
                {
                    if (dbContext.Database.GetDbConnection() != transaction.Connection)
                    {
                        dbContext.Database.SetDbConnection(transaction.Connection, contextOwnsConnection: false);
                    }

                    await dbContext.Database.UseTransactionAsync(transaction, token);

                    // Accepted only once committed: a retried commit has to save the same changes again.
                    await dbContext.SaveChangesAsync(acceptAllChangesOnSuccess: false, token);
                },
                cancellationToken);

            dbContext.ChangeTracker.AcceptAllChanges();
        }
        finally
        {
            await dbContext.Database.UseTransactionAsync(null, cancellationToken);
        }
    }
}
```

- **The billing context saves first.** Its domain event handlers publish into the application's outbox, so those rows must exist before `BlouppyDbContext` saves.
- **`acceptAllChangesOnSuccess: false`** keeps the billing changes pending until the commit succeeds. If the execution strategy replays the block, the second attempt saves them again.
- **It only works because both contexts point at the same PostgreSQL database.** A transaction belongs to one connection.

With two databases, no such trick exists. The Starter does not have that case, and the usual options are an outbox in each database with eventual consistency between them, or a distributed transaction, with the coordinator and the failure modes it brings. Most teams pick the first.


## Pitfalls
- **`SaveChangesAsync` inside a repository.** The next repository in the use case runs after a commit it cannot undo, and the domain events are dispatched on a half-finished change. In the Starter's database adapter, `SaveChangesAsync` appears in `UnitOfWork`, the development seed and one repository with a reason: the account erasure, which runs as a single transaction of its own.
- **Several saves in one use case.** Each save is a separate step: the second can fail after the first committed, and each one dispatches the domain events recorded so far. If we need an ID before the end, a [HiLo sequence](/blog/2026-05-16-strongly-typed-ids-with-ef-core/) gives it on `Add`, without a save.
- **Long-lived contexts.** A `DbContext` held by a singleton or reused across requests keeps a growing change tracker, serves stale entities and is not thread-safe. `AddDbContext` registers it as scoped: one context, one unit of work, per request or per message.
- **Set-based statements.** `ExecuteUpdateAsync`, `ExecuteDeleteAsync` and raw SQL run immediately and bypass the change tracker, so they are not part of the unit of work unless a transaction is already open. The Starter's AI credit charge checks `Database.CurrentTransaction` and joins it when there is one.
- **A forgotten commit.** Nothing fails when a controller forgets `CommitAsync`. The scope ends, the context is disposed and the changes are lost silently. An integration test that reads the row back with another context is the only guard.


## When not to bother
The port earns its place when the code that decides to commit must not know EF Core, and when the commit coordinates something: interceptors, an outbox, a second context. Without those, it is an extra name for `SaveChangesAsync`.

- **Simple CRUD.** A controller or a minimal API endpoint that injects the `DbContext`, changes an entity and calls `SaveChangesAsync` already uses a unit of work, transaction included.
- **A small service with one project.** If the domain and the data access live together, an interface over the context protects nothing.
- **A generic repository plus a generic unit of work over EF Core** usually adds two layers that do what `DbSet<T>` and `DbContext` already do.

The costs are real too. The port leaks a little: the `alongside` overload takes a `DbTransaction` from `System.Data.Common`, a compromise to let Billing join. The commit lives far from the changes, in the controller, so a reader must know the convention to see where the data is written. And because the interceptors do most of the work, a single `CommitAsync` line can run handlers we did not write.


## Conclusion
A unit of work tracks the changes of one business transaction and writes them together. EF Core's `DbContext` already does it; the `IUnitOfWork` port in the Starter exists so that the domain never references EF Core, repositories never save, and each use case has one visible commit. Inside that commit, domain events, audit stamps, concurrency checks and outbox rows all ride on the same transaction, and a module with its own context joins it by sharing the connection. For a simple application, inject the context and call `SaveChangesAsync`: that is the same pattern, without the port.

`UnitOfWork`, `BillingUnitOfWork` and the interceptors are in [Blouppy Starter](https://starter.blouppy.com/).


## References
- [Unit of Work (Martin Fowler)](https://martinfowler.com/eaaCatalog/unitOfWork.html) — the pattern's entry in the catalog of *Patterns of Enterprise Application Architecture*.
- [DbContext Lifetime, Configuration, and Initialization](https://learn.microsoft.com/ef/core/dbcontext-configuration/) — EF Core documentation: a context per unit of work, and why it is not thread-safe.
- [Basic SaveChanges](https://learn.microsoft.com/ef/core/saving/basic) — EF Core documentation: how the change tracker turns into statements.
- [Using Transactions](https://learn.microsoft.com/ef/core/saving/transactions) — EF Core documentation: explicit transactions and sharing one across contexts.
- [Connection Resiliency](https://learn.microsoft.com/ef/core/miscellaneous/connection-resiliency) — EF Core documentation: execution strategies and user-initiated transactions.
- [Interceptors](https://learn.microsoft.com/ef/core/logging-events-diagnostics/interceptors) — EF Core documentation: `SaveChangesInterceptor` and transaction interceptors.
- [Domain events vs integration events in .NET, and the transactional outbox](/blog/2026-05-28-domain-events-vs-integration-events-and-the-outbox/) — the dispatch and the outbox this commit relies on.
- [Optimistic concurrency with PostgreSQL xmin in EF Core](/blog/2026-08-02-optimistic-concurrency-with-postgresql-xmin-in-ef-core/) — the concurrency check inside the save.
