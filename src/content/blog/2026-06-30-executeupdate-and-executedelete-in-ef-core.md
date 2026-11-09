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

The usual way to change rows with EF Core is to load the entities, change their properties and call `SaveChanges`. For one aggregate, that is exactly right. For "mark the 800 unread notifications of this person as read", it means reading 800 rows, building 800 objects and sending 800 `UPDATE` statements. All that to change one column the database could have changed in one statement.

Since EF Core 7, `ExecuteUpdate` and `ExecuteDelete` send that one statement. They are fast, and they skip almost everything `SaveChanges` does for us.


## One statement, no change tracking
Both methods are terminal operators on an `IQueryable<T>`, like `ToListAsync`. Whatever comes before them becomes the `WHERE` clause of an `UPDATE` or a `DELETE`:

```csharp
var deleted = await dbContext.Orders
    .Where(x => x.Status == OrderStatus.Cancelled && x.CreatedAt < cutoff)
    .ExecuteDeleteAsync(cancellationToken);

await dbContext.Products
    .Where(x => x.CategoryId == categoryId)
    .ExecuteUpdateAsync(
        setters => setters
            .SetProperty(x => x.Price, x => x.Price * 1.05m)
            .SetProperty(x => x.IsOnSale, false),
        cancellationToken);
```

Nothing is loaded and nothing is tracked. The statement runs **when the method is called**, not at the next `SaveChanges`, and returns the number of rows affected. In the update, the first setter is computed by the database (`SET price = p.price * 1.05`) and the second is a parameter.

Up to EF Core 9, the setters were an expression tree, so we could not put an `if` in them. EF Core 10 accepts a plain lambda, and ordinary control flow works:

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

The lambdas inside each `SetProperty` are still translated to SQL. Only the outer one became plain code, and the fluent chain still compiles.


## What we give up
`SaveChanges` is where EF Core does its work. Bypassing it bypasses all of it.

**The change tracker goes stale.** If the context already tracks one of the rows, its entity keeps the old values. If that entity is then modified, the next `SaveChanges` writes the stale values back over the bulk change. Run bulk statements in a context that has not loaded those rows.

**Interceptors do not run.** A `SaveChangesInterceptor` reads the change tracker, and a bulk statement puts nothing in it. In [Blouppy Starter](https://starter.blouppy.com/), interceptors stamp `CreatedBy` and `LastModifiedDate` and dispatch the [domain events](/blog/2026-05-28-domain-events-vs-integration-events-and-the-outbox/) of tracked aggregates. After an `ExecuteUpdate`, the audit columns keep their old values and no event is raised. A `DbCommandInterceptor` still sees the SQL.

**Concurrency tokens are not checked.** `SaveChanges` adds the token's original value to the `WHERE` and throws when no row matches. A bulk statement has no original value. If a token matters, put it in the `Where` and look at the returned count.

**Cascades are the database's.** `ExecuteDelete` sends one `DELETE` to one table. The dependents follow only if the foreign key is `ON DELETE CASCADE`.

**The statement commits on its own.** Without an open transaction, each call is committed when it returns. Two bulk calls followed by a failing `SaveChanges` leave the first two applied.


## Compensating at the call site
The Starter uses bulk statements in a handful of repositories, and each one says what it skips. Marking every notification as read is the opening example:

```csharp
public async Task<int> MarkAllAsReadAsync(
    UserId recipientId,
    CancellationToken cancellationToken = default)
{
    var readAt = DateTimeOffsetProvider.UtcNow;

    return await dbContext.Notifications
        .Where(x => x.RecipientId == recipientId && x.ReadAt == null)
        .ExecuteUpdateAsync(
            setters => setters.SetProperty(x => x.ReadAt, readAt),
            cancellationToken);
}
```

This is slightly simplified from the real method. The timestamp is computed once in C#, so every row gets the same `ReadAt`. The `ReadAt == null` filter makes a second call change nothing. And the audit log's coverage table lists this write as deliberately not audited, so nobody expects an event from it.

Transferring the workspaces of a deprovisioned member to someone else has the same shape. It filters on the old owner, so a message delivered twice transfers nothing the second time. The workspaces' `LastModifiedBy` does not move, so the handler logs the count instead.

When several statements must commit together, open a transaction. The GDPR erasure runs dozens of them, table by table:

```csharp
var strategy = dbContext.Database.CreateExecutionStrategy();

return await strategy.ExecuteAsync(async () =>
{
    await using var transaction = await dbContext.Database.BeginTransactionAsync(cancellationToken);

    await dbContext.SaveChangesAsync(cancellationToken);

    // ... ExecuteUpdateAsync and ExecuteDeleteAsync, table by table

    await transaction.CommitAsync(cancellationToken);
});
```

With retries enabled, a transaction opened by hand must run inside the execution strategy, so a retry replays the whole block. The tracked changes are saved first, inside the same transaction. A repository that cannot know whether its caller already opened one checks `Database.CurrentTransaction` and joins it if there is one.


## When to load the entities instead
Bulk statements fit purges and retention, transfers driven by an event, counters and flags on many rows, and storage migrations such as re-encrypting a column. Skipping the interceptors is sometimes the point: a one-off job that encrypts stored secrets should not stamp `LastModifiedBy`, because nobody edited them.

Load the entities when an invariant lives in the aggregate, because a statement that writes the table directly does not check it. Load them when something should react, such as a domain event or an audit entry. And load them when the rows are few: renaming one workspace through the aggregate costs nothing worth saving, and keeps the audit columns, the concurrency check and the events for free.


## References
- [ExecuteUpdate and ExecuteDelete](https://learn.microsoft.com/ef/core/saving/execute-insert-update-delete) — Microsoft Learn: the guide, with the change tracking and transaction caveats.
- [What's new in EF Core 10](https://learn.microsoft.com/ef/core/what-is-new/ef-core-10.0/whatsnew) — Microsoft Learn: the non-expression lambda for `ExecuteUpdateAsync`.
- [Interceptors](https://learn.microsoft.com/ef/core/logging-events-diagnostics/interceptors) — Microsoft Learn: `SaveChangesInterceptor` versus `DbCommandInterceptor`.
- [Connection resiliency](https://learn.microsoft.com/ef/core/miscellaneous/connection-resiliency) — Microsoft Learn: execution strategies and user-initiated transactions.
