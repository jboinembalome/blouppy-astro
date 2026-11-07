---
templateKey: 'blog-post'
title: 'Optimistic concurrency with PostgreSQL xmin in EF Core'
date: 2026-08-02T09:00:00.000Z
updated: 2026-11-07T09:00:00.000Z
author: Jimmy Boinembalome
authorimage: /img/jimmy.jpg
category: C#
topic: 'Data'
illustration: 3
categorycolor: bg-purple-100 text-purple-800
featuredpost: true
featuredimage: /img/optimistic-concurrency-with-postgresql-xmin-in-ef-core.jpg
description: >-
  Learn how to let exactly one of several writers win the same row, without locks, using PostgreSQL's xmin column as an EF Core concurrency token, plus a claim and a lease.
tags:
  - Development
  - C#
  - EF Core
  - PostgreSQL
  - Concurrency
---

Some rows have more than one writer. A webhook delivery waiting for its next attempt can be re-queued by a scheduled sweep while a person clicks **Redeliver**: if both win, the subscriber receives the event twice. Rather than a `SELECT ... FOR UPDATE` lock every writer must remember, we let everyone try and make the database refuse every commit but the first.

In this article, we will use PostgreSQL's `xmin` system column as an [optimistic concurrency](https://learn.microsoft.com/ef/core/saving/concurrency) token in EF Core, add a **claim** and a **lease** on top of it, and see how a failed commit also rolls back the messages written in the same transaction.


## What is xmin?
Every PostgreSQL row has hidden [system columns](https://www.postgresql.org/docs/current/ddl-system-columns.html). One of them, `xmin`, holds the id of the transaction that wrote the current version of the row. Each `UPDATE` creates a new row version, so `xmin` changes every time the row changes: a row version every table already has.

Optimistic concurrency then works like this:
- EF Core reads the row and remembers its `xmin`.
- On `SaveChanges`, it adds `AND xmin = <the value it read>` to the `WHERE` clause of the `UPDATE`.
- If another transaction changed the row in between, the `UPDATE` matches zero rows, and EF Core throws a [`DbUpdateConcurrencyException`](https://learn.microsoft.com/dotnet/api/microsoft.entityframeworkcore.dbupdateconcurrencyexception).

Roughly, the statement looks like this:

```text:clipboard=false
UPDATE webhook_deliveries SET claim_id = @p0, next_attempt_at = @p1
WHERE id = @p2 AND xmin = @p3
RETURNING xmin;
```


## Mapping xmin in EF Core
Here is the relevant line of `WebhookDeliveryConfiguration`, where `VersionPropertyName` is `"Version"`:

```csharp
// Optimistic concurrency on xmin, so two sweepers cannot claim or record the same attempt.
// Named explicitly: the snake-case convention would otherwise create a real "version" column.
builder.Property<uint>(VersionPropertyName)
    .HasColumnName("xmin")
    .HasColumnType("xid")
    .IsRowVersion();
```

- `Property<uint>(VersionPropertyName)` declares a [shadow property](https://learn.microsoft.com/ef/core/modeling/shadow-properties), in the EF model but not on the entity: the domain class knows nothing about `xmin`.
- `.HasColumnType("xid")` is PostgreSQL's transaction id type, a `uint`; `.IsRowVersion()` says the database generates it on every update and that it is a concurrency token.
- `.HasColumnName("xmin")` is the critical line. The code base uses a snake-case naming convention, so without it the property `Version` becomes a new `version` column that nothing ever updates. The check would compare a value that never changes, and always pass.

> **_Note:_**  This is the mapping the [Npgsql concurrency documentation](https://www.npgsql.org/efcore/modeling/concurrency.html) describes: a `uint` property marked `IsRowVersion()`. The older `UseXminAsConcurrencyToken()` extension is no longer needed.

The generated migration mentions the column (`xmin = table.Column<uint>(type: "xid", rowVersion: true, nullable: false)`), but the Npgsql provider knows `xmin` is a system column and does not emit it in the `CREATE TABLE`.


## A claim and a lease
The concurrency token tells us *who committed first*. It does not tell a message consumer, minutes later, whether it is still allowed to act. For that, the entity carries a **claim**:

```csharp
// Minted by each Claim and carried by the dispatch message, so a duplicated or stale message
// finds a token that is no longer the row's and leaves the attempt alone.
public Guid? ClaimId { get; private set; }

public bool IsClaimedBy(Guid claimId)
    => Status == WebhookDeliveryStatus.Pending
       && ClaimId == claimId;

public Guid Claim()
{
    NextAttemptAt = DateTimeOffsetProvider.UtcNow.Add(WebhookRules.ClaimLease);
    ClaimId = Guid.NewGuid();

    return ClaimId.Value;
}
```

`Claim()` pushes `NextAttemptAt` out by the **lease**, so the next sweep skips the row, and stamps a fresh `ClaimId`, which makes the previous token worthless. The constructor calls it too, so a new delivery is born leased.

The lease, `WebhookRules.ClaimLease`, is two minutes: longer than the ten-second `WebhookRules.SendTimeout`, so an attempt still running is never re-queued underneath itself, and short enough that a process dying mid-attempt costs a delay, not the delivery.


## Claim and publish in one commit
The sweep job calls `IWebhookDeliveryService.DispatchDueAsync` (abridged):

```csharp
var due = await webhookDeliveriesRepository.GetDueAsync(
    DateTimeOffsetProvider.UtcNow,
    maximumCount,
    cancellationToken);

// ... returns 0 when nothing is due

foreach (var delivery in due)
{
    var claimId = delivery.Claim();

    await deliveryRequestedPublisher.PublishAsync(
        new WebhookDeliveryRequestedIntegrationEvent(delivery.Id, claimId),
        cancellationToken);
}

// Claims and outbox messages commit together; a replica that claimed the same rows first makes this throw and roll back.
await unitOfWork.CommitAsync(cancellationToken);

return due.Count;
```

Each due row is claimed, and an event carrying the **new** `ClaimId` is published. The publish does not reach RabbitMQ yet: it joins the [Wolverine transactional outbox](https://wolverinefx.net/guide/durability/efcore/), as a row in the same PostgreSQL transaction as the claims. If a redelivery claimed one of these rows in between, its `UPDATE ... AND xmin = ...` matches nothing, EF Core throws, and the **whole** transaction rolls back: the claims *and* the outbox messages. A losing writer leaves nothing behind.

**Redeliver** follows the same shape: `TryRedeliverAsync` calls `delivery.Redeliver()`, which calls `Claim()`, publishes, and the controller commits through `IUnitOfWork`. Whichever commits first wins.

The sweep job treats the conflict as an expected outcome:

```csharp
try
{
    await deliveryService.DispatchDueAsync(options.Value.SweepBatchSize, cancellationToken);
}
catch (DbUpdateConcurrencyException)
{
    // A redelivery claimed the same rows first; this whole batch rolled back, so nothing is queued twice.
    logger.LogInformation(
        "Another writer re-queued the same webhook deliveries first; this sweep rolled back");
}
```

There is no retry loop: the rows the sweep lost are no longer due, and the next sweep finds the rest of the batch.

> **_Note:_**  Quartz.NET's clustered store with [`[DisallowConcurrentExecution]`](https://www.quartz-scheduler.net/documentation/quartz-3.x/tutorial/more-about-jobs.html) already runs one sweep at a time. But that lock is not what makes this safe: a person clicking **Redeliver** never goes through the scheduler.


## The consumer: compare the token, skip on mismatch
`WebhookDeliveryRequestedIntegrationEvent` carries only two values, the delivery id and the claim token. The consumer calls `IWebhookDeliveryService.SendAsync`, which starts by checking the claim:

```csharp
// A stale duplicate or a message whose lease the sweeper took back no longer holds the claim.
if (!delivery.IsClaimedBy(claimId))
{
    logger.LogInformation(
        "Webhook delivery {DeliveryId} is {Status} and no longer claimed by {ClaimId}; skipping",
        id,
        delivery.Status,
        claimId);

    return;
}
```

A message is stale when the broker delivered it twice or the row was re-claimed since; either way, a newer message holds the current token, and the stale copy costs one read, not one HTTP request.

After the attempt, `MarkAsSucceeded` or `MarkAsFailed` clears `ClaimId`, and the result is committed with the same `xmin` check, so a writer that touched the row in between makes this commit fail instead of being overwritten.

Each mechanism has one role:
- **`xmin`** decides who wins *at commit time*, between writers that read the same version.
- **`ClaimId`** decides who may act *later*, once the winning message reaches a consumer.
- **The lease** decides when a claim nobody honoured can be taken back.


## Testing it on a real database
The in-memory provider knows nothing about `xmin`, so this needs PostgreSQL. The integration test `Should_refuse_the_second_claim_when_two_replicas_claim_the_same_row`, in `WebhookDeliveriesRepositoryTests`, simulates two replicas with two `DbContext` instances (abridged):

```csharp
await using var otherReplica = _databaseFixture.CreateBlouppyDbContext();

var ours = await ActDbContext.WebhookDeliveries
    .SingleAsync(x => x.Id == delivery.Id, TestContext.Current.CancellationToken);

var theirs = // ... the same row, read through otherReplica

theirs.Claim();
await otherReplica.SaveChangesAsync(TestContext.Current.CancellationToken);

ours.Claim();

// Act
var act = () => ActDbContext.SaveChangesAsync(TestContext.Current.CancellationToken);

// Assert
await act.Should()
    .ThrowAsync<DbUpdateConcurrencyException>();

// ... and a fresh context reads theirs.ClaimId as the stored token
```

The other replica commits first, ours fails, and the winner's token is the one stored. The test also catches the mapping mistake described earlier: with a real `version` column, both saves would succeed.


## When xmin is not the right token
`xmin` changes on *any* update of the row, which suits a delivery, where every write matters. When only one column matters, an ordinary column marked [`IsConcurrencyToken()`](https://learn.microsoft.com/ef/core/modeling/concurrency) is enough. The AI assistant's proposals mark their `Status` that way, and conversations their `UpdatedAt`. Two decisions on the same waiting proposal both send `WHERE status = 'Pending'`, and the second matches no row. Since this conflict comes from an HTTP request, `GlobalExceptionHandler` turns it into a proper answer by checking which entity failed:

```csharp
private static bool IsAssistantProposalDecidedTwice(Exception exception)
    => exception is DbUpdateConcurrencyException concurrency
       && concurrency.Entries.Any(x => x.Entity is AssistantProposal);
```

`DbUpdateConcurrencyException.Entries` lists the failed entries, so one global handler can tell this conflict from any other.


## Conclusion
With PostgreSQL, the row version already exists: map a `uint` shadow property to `xmin` with `IsRowVersion()`, name the column explicitly, and the database picks one winner at commit time. When the winner acts later through a message, add a claim token the consumer checks, a lease that lets a forgotten claim be taken back, and one transaction for the claims and the outbox.

This is how webhook deliveries are claimed and sent in [Blouppy Starter](https://starter.blouppy.com/). The [webhooks documentation](https://docs.starter.blouppy.com/modules/webhooks/) covers the rest of the delivery pipeline.


## References
- [Handling concurrency conflicts](https://learn.microsoft.com/ef/core/saving/concurrency) — EF Core's optimistic concurrency model and `DbUpdateConcurrencyException`.
- [Concurrency tokens](https://learn.microsoft.com/ef/core/modeling/concurrency) — `IsConcurrencyToken()` and `IsRowVersion()` in the EF Core model.
- [Shadow and indexer properties](https://learn.microsoft.com/ef/core/modeling/shadow-properties) — properties that live in the EF model but not on the entity.
- [DbUpdateConcurrencyException class](https://learn.microsoft.com/dotnet/api/microsoft.entityframeworkcore.dbupdateconcurrencyexception) — the exception and its `Entries`.
- [Npgsql: Concurrency tokens](https://www.npgsql.org/efcore/modeling/concurrency.html) — mapping a `uint` property to `xmin`.
- [PostgreSQL: System columns](https://www.postgresql.org/docs/current/ddl-system-columns.html) — what `xmin` holds.
- [Wolverine: Entity Framework Core integration](https://wolverinefx.net/guide/durability/efcore/) — the transactional outbox on a `DbContext`.
- [Quartz.NET: More about jobs](https://www.quartz-scheduler.net/documentation/quartz-3.x/tutorial/more-about-jobs.html) — `[DisallowConcurrentExecution]`.
- [Blouppy Starter: Webhooks](https://docs.starter.blouppy.com/modules/webhooks/) — the delivery pipeline this article comes from.
