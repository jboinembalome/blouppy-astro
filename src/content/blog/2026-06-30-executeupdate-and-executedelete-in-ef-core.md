---
templateKey: 'blog-post'
title: 'ExecuteUpdate and ExecuteDelete in EF Core: bulk changes without loading entities'
date: 2026-06-30T09:00:00.000Z
author: Jimmy Boinembalome
authorimage: /img/jimmy.jpg
category: C#
topic: 'Data'
illustration: 1
categorycolor: bg-purple-100 text-purple-800
featuredpost: true
description: >-
  Learn how ExecuteUpdate and ExecuteDelete turn a LINQ query into one SQL statement in EF Core 10, what they skip compared to SaveChanges, and when that trade is worth it.
tags:
  - Development
  - C#
  - EF Core
  - PostgreSQL
---

The usual way to change rows with EF Core is to load the entities, change their properties and call `SaveChanges`. For one aggregate, that is exactly right: the change tracker knows what changed, the interceptors stamp the audit columns, the domain events are dispatched. For "mark the 800 unread notifications of this person as read", it means reading 800 rows over the network, building 800 objects, comparing 800 snapshots and sending 800 `UPDATE` statements, to change one column that the database could have changed in one statement.

Since EF Core 7, `ExecuteUpdate` and `ExecuteDelete` send that one statement. They are fast, and they skip almost everything `SaveChanges` does for us.

In this article, we will see how the two methods work in EF Core 10, what they leave out, how real repositories compensate for it, and when loading the entities is still the better choice.


## One statement, no change tracking
Both methods are terminal operators on an `IQueryable<T>`, like `ToListAsync`. Whatever comes before them (`Where`, joins, subqueries) becomes the `WHERE` clause of an `UPDATE` or a `DELETE`. On PostgreSQL, this query:

```csharp
var deleted = await dbContext.Notifications
    .Where(x => x.RecipientId == recipientId)
    .ExecuteDeleteAsync(cancellationToken);
```

becomes, roughly:

```sql
DELETE FROM blouppy.notifications AS n
WHERE n.recipient_id = @recipientId
```

- Nothing is loaded and nothing is tracked.
- The statement runs **when the method is called**, not at the next `SaveChanges`.
- The return value is the number of rows affected, which is often the only result a bulk operation needs.

`ExecuteUpdate` takes the columns to set. Each `SetProperty` names a property and either a value or an expression over the row itself:

```csharp
await dbContext.Products
    .Where(x => x.CategoryId == categoryId)
    .ExecuteUpdateAsync(
        setters => setters
            .SetProperty(x => x.Price, x => x.Price * 1.05m)
            .SetProperty(x => x.IsOnSale, false),
        cancellationToken);
```

The first setter is computed by the database (`SET price = p.price * 1.05`), the second is a parameter. Mapped value converters apply, so a [strongly-typed ID](/blog/2026-05-16-strongly-typed-ids-with-ef-core/) can be passed to `SetProperty` as it is.


## What changed in EF Core 10
Up to EF Core 9, the setters argument was an **expression tree**, `Expression<Func<SetPropertyCalls<T>, SetPropertyCalls<T>>>`. EF Core had to read the chain of calls, so we could not put an `if` in it. Setting a column only when a value was supplied meant building the expression by hand.

EF Core 10 accepts a regular, non-expression lambda. The setters are now calls on a builder, and ordinary C# control flow works:

```csharp
await dbContext.Products
    .Where(x => x.Id == productId)
    .ExecuteUpdateAsync(
        setters =>
        {
            setters.SetProperty(x => x.Price, price);

            if (name is not null)
            {
                setters.SetProperty(x => x.Name, name);
            }
        },
        cancellationToken);
```

The fluent chain from the previous section still compiles unchanged. The lambdas inside each `SetProperty` (`x => x.Price`, `x => x.Price * 1.05m`) are still translated to SQL; only the outer lambda became plain code.


## What we give up
`SaveChanges` is where EF Core does its work. Bypassing it bypasses all of it, and the list is longer than "no change tracking".

### The change tracker goes stale
If the context already tracks one of the rows, its entity keeps the old values. Worse, if that entity is modified afterwards, the next `SaveChanges` writes its stale values back over what the bulk statement did. Run bulk statements in a context that has not loaded those rows, or reload them afterwards.

### SaveChanges interceptors do not run
Any `SaveChangesInterceptor` reads the change tracker, and a bulk statement puts nothing in it. In [Blouppy Starter](https://starter.blouppy.com/), three interceptors live on `BlouppyDbContext`: `CreatedEntityInterceptor` and `ModifiedEntityInterceptor` stamp `CreatedBy`, `CreatedDate`, `LastModifiedBy` and `LastModifiedDate`, and `PublishDomainEventsInterceptor` dispatches the domain events of tracked aggregates (see [domain events, integration events and the outbox](/blog/2026-05-28-domain-events-vs-integration-events-and-the-outbox/)). After an `ExecuteUpdate`, the audit columns keep their old values and no domain event is raised. Command interceptors (`DbCommandInterceptor`) still see the SQL, since a command is still sent.

### Concurrency tokens are not checked
`SaveChanges` adds the original value of a concurrency token to the `WHERE` clause and throws `DbUpdateConcurrencyException` when no row matches. A bulk statement has no original value to compare. If a token matters, put it in the `Where` ourselves and look at the returned count. On PostgreSQL, a token mapped to the `xmin` system column is at least bumped by any `UPDATE`, so readers still see the change; an application-managed token (a `Guid` regenerated on save) is not, unless we set it in the statement.

### Cascades are the database's
`Remove` on a tracked entity lets EF Core delete or detach the dependents it tracks. `ExecuteDelete` sends one `DELETE` to one table: the dependents follow only if the foreign key is `ON DELETE CASCADE` in the database.

### The statement is committed on its own
Without an open transaction, each call is its own implicit transaction and is committed when it returns. Two `ExecuteUpdateAsync` calls followed by a failing `SaveChanges` leave the first two applied. To make them succeed or fail together, open a transaction with `Database.BeginTransactionAsync`: bulk statements then run inside it like everything else on that connection.


## Real examples
Blouppy Starter uses the two methods in its EF Core adapter, `Blouppy.Infrastructure.Database`, for a handful of cases. Each one shows how the code compensates for what is skipped.

### Marking every notification as read
`NotificationsRepository.MarkAllAsReadAsync` is the opening example of this article. Its comment states the reason and the consequence:

```csharp
/// <remarks>
/// A set-based update rather than loading the rows: a reader who has been away comes back to
/// hundreds, and materialising them only to stamp one column each is work nobody asked for.
/// It writes immediately and outside the unit of work, which is what the caller wants here:
/// there is nothing else in the transaction to keep it consistent with.
/// </remarks>
public async Task<int> MarkAllAsReadAsync(
    UserId recipientId,
    CancellationToken cancellationToken = default)
{
    using (DateTimeOffsetProvider.Scope())
    {
        var readAt = DateTimeOffsetProvider.UtcNow;

        return await dbContext.Notifications
            .Where(x => x.RecipientId == recipientId && x.ReadAt == null)
            .ExecuteUpdateAsync(
                setters => setters.SetProperty(x => x.ReadAt, readAt),
                cancellationToken);
    }
}
```

- The timestamp is computed once in C# and sent as a parameter, so every row gets the same `ReadAt`.
- `ReadAt == null` in the filter makes the call idempotent: a second call changes nothing.
- The audit log has a row for this write in its coverage table, marked as not audited because it concerns only the person's own notifications. That decision is explicit, so nobody later expects an event from it.

The purge of old notifications uses `ExecuteDeleteAsync` in batches of 1,000. The batch is a subquery, `Where(x => oldest.Contains(x.Id))`, over the oldest rows ordered by `CreatedAt` and `Take(batchSize)`, and the service loops until a batch comes back short. The service explains the size: small enough that one batch never holds a lock on the table a reader is waiting on.

### Moving ownership without moving the audit columns
`WorkspacesRepository.TransferOwnershipAsync` gives every workspace of an organization owned by one person to another. It is called by an integration event handler, when the organization's identity provider deprovisions a member:

```csharp
public async Task<int> TransferOwnershipAsync(
    OrganizationId organizationId,
    UserId fromOwnerId,
    UserId toOwnerId,
    CancellationToken cancellationToken = default)
    => await dbContext.Workspaces
        .Where(x => x.OrganizationId == organizationId && x.OwnerId == fromOwnerId)
        .ExecuteUpdateAsync(
            setters => setters.SetProperty(x => x.OwnerId, toOwnerId),
            cancellationToken);
```

The port documents the two consequences the caller has to know: the change happens "at once rather than through the unit of work", and the method returns how many workspaces changed hands, "none on a second call". The second one matters because a message can be delivered twice: filtering on `fromOwnerId` makes the handler safe to run again. `Workspace` is an `AuditableEntityBase`, and its `LastModifiedBy` does not move here; the handler logs the count instead. `TeamsRepository.RemoveMemberAsync` follows the same shape with `ExecuteDeleteAsync`, removing a member from every team of the organization's workspaces through a correlated subquery.

The same reasoning is spelled out where it is a feature. A one-off job that encrypts webhook secrets written in clear updates each row with `ExecuteUpdateAsync`, and says why:

```csharp
/// <summary>
/// A set-based update per row, so neither the audit columns nor a domain event move:
/// the webhook did not change, its storage did. Idempotent: an encrypted row is never
/// selected again.
/// </summary>
```

Skipping the interceptors is the point: an audit column saying the owner edited the webhook at deployment time would be false.

### The account erasure: many statements, one transaction
The GDPR erasure is the opposite case: dozens of bulk statements across organizations, memberships, teams and every audit column the person ever wrote. `UserErasureRepository` opens a transaction first, so the whole sweep commits or nothing does:

```csharp
var strategy = dbContext.Database.CreateExecutionStrategy();

return await strategy.ExecuteAsync(async () =>
{
    await using var transaction = await dbContext.Database.BeginTransactionAsync(cancellationToken);

    // Whatever the caller already changed goes in first,
    // so the record of the erasure shares its fate.
    await dbContext.SaveChangesAsync(cancellationToken);

    // ... ExecuteUpdateAsync and ExecuteDeleteAsync, table by table

    await transaction.CommitAsync(cancellationToken);
});
```

- With retries enabled, a transaction opened by hand must run inside `CreateExecutionStrategy().ExecuteAsync`, so a retry replays the whole block.
- The tracked changes are saved inside the transaction before the bulk statements run.
- Deleting an organization is a single `ExecuteDeleteAsync`, with the comment "the foreign keys cascade from here down through members, invitations, entitlements, workspaces, teams...": the cascade is the database's, as described above.
- The class's summary gives the reason for bulk statements, rewriting an audit column on every row a long-lived account touched, "and materializing those to change one string each would turn a second into a minute", and adds that nothing here depends on an aggregate's invariants.

### Joining a transaction that is already open
A repository cannot always know whether its caller opened a transaction. `AiCreditPeriodsRepository.ChargeAsync` asks:

```csharp
if (dbContext.Database.CurrentTransaction is not null)
{
    return await ChargeInTransactionAsync(organizationId, month, credits, allowance, cancellationToken);
}

return await dbContext.Database.CreateExecutionStrategy().ExecuteAsync(async () =>
{
    await using var transaction = await dbContext.Database.BeginTransactionAsync(cancellationToken);

    var charged = await ChargeInTransactionAsync(organizationId, month, credits, allowance, cancellationToken);

    await transaction.CommitAsync(cancellationToken);

    return charged;
});
```

The charge itself is raw SQL rather than `ExecuteUpdate`, because it needs an upsert and a row lock (`FOR UPDATE`), and EF Core has an operator for neither. The pattern is the same for any statement that runs at once: join `Database.CurrentTransaction` when there is one, open one otherwise.


## When to use them, and when not
Bulk statements fit:

- **Purges and retention**: old notifications, settled webhook deliveries, expired usage records. No aggregate rule applies to a row that is going away.
- **Bulk transfers and cascades driven by an event**: ownership changes, memberships removed when someone leaves an organization.
- **Counters and flags on many rows**: `read_at`, `credits_used = credits_used + n`, where the database can compute the new value itself.
- **Storage migrations**: re-encrypting or re-formatting data that did not change in meaning.

Load the entities when:

- **An invariant lives in the aggregate.** A rule an entity checks in its methods is not checked by a statement that writes its table directly. The bulk path is fine only when the rule is guaranteed another way, or does not apply.
- **Something listens.** A domain event, an audit entry, a real-time signal: if a handler should react, either go through the aggregate or publish the integration event explicitly next to the statement.
- **The rows are few.** Loading one workspace to rename it costs nothing worth saving, and it keeps the audit columns, the concurrency check and the events for free.
- **The change must commit with other tracked changes**, and opening an explicit transaction is more ceremony than the gain.

For most writes of a typical API, `SaveChanges` stays the default. The bulk methods are an optimisation with a cost, and each use deserves the comment the examples above carry: why the rows are not loaded, and what is not triggered because of it.


## Conclusion
`ExecuteUpdate` and `ExecuteDelete` turn a LINQ query into one `UPDATE` or `DELETE`, without loading anything. EF Core 10 made `ExecuteUpdate` easier to write by accepting a plain lambda for the setters. What they skip is everything `SaveChanges` does: the change tracker, the interceptors that stamp audit columns and dispatch domain events, the concurrency check, the client-side cascade and the shared transaction. Use them for purges, transfers and counters, make them idempotent, open a transaction when several must commit together, and write down at the call site what they deliberately leave out. For the reads and writes of a single aggregate, see how the read and write sides stay apart in [separating reads and writes without MediatR](/blog/2026-06-21-separating-reads-and-writes-without-mediatr/).


## References
- [ExecuteUpdate and ExecuteDelete](https://learn.microsoft.com/ef/core/saving/execute-insert-update-delete) — the official guide, with the change tracking and transaction caveats.
- [What's new in EF Core 10](https://learn.microsoft.com/ef/core/what-is-new/ef-core-10.0/whatsnew) — the non-expression lambda for `ExecuteUpdateAsync`.
- [What's new in EF Core 7](https://learn.microsoft.com/ef/core/what-is-new/ef-core-7.0/whatsnew) — where the two methods were introduced.
- [Interceptors](https://learn.microsoft.com/ef/core/logging-events-diagnostics/interceptors) — `SaveChangesInterceptor` versus `DbCommandInterceptor`.
- [Handling concurrency conflicts](https://learn.microsoft.com/ef/core/saving/concurrency) — concurrency tokens and `DbUpdateConcurrencyException`.
- [Connection resiliency](https://learn.microsoft.com/ef/core/miscellaneous/connection-resiliency) — execution strategies and user-initiated transactions.
- [Blouppy Starter](https://starter.blouppy.com/) — the code base the examples come from.
