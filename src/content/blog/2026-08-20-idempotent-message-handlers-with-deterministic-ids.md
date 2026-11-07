---
templateKey: 'blog-post'
title: 'Idempotent message handlers in .NET: deterministic IDs from the message ID'
date: 2026-08-20T09:00:00.000Z
updated: 2026-11-07T09:00:00.000Z
author: Jimmy Boinembalome
authorimage: /img/jimmy.jpg
category: C#
topic: 'Messaging'
illustration: 3
categorycolor: bg-purple-100 text-purple-800
featuredpost: true
featuredimage: /img/idempotent-message-handlers-with-deterministic-ids.jpg
description: >-
  Learn how to make a .NET message handler idempotent by deriving the ids of the rows it writes from the id of the message it consumes.
tags:
  - Development
  - C#
  - .NET
  - Messaging
  - EF Core
  - PostgreSQL
---

A message broker promises **at least once**, not exactly once: if a handler throws, the message comes back, and a failure in *any* of its handlers replays *all* of them. A handler that inserts a row with `Guid.NewGuid()` writes a duplicate on every retry, even though it succeeded the first time.

In this article, we will make such a handler [idempotent](https://www.enterpriseintegrationpatterns.com/patterns/messaging/IdempotentReceiver.html) without a locking table or a deduplication cache: each row's id is derived from the bus message's id, so a retry recomputes the same ids, finds its rows already there, and adds nothing.


## Why the handler runs again
The retry policy decides how many times a handler sees the same message. In the code base this comes from, the bus is [Wolverine](https://wolverinefx.net/), and the policy is plain options in `MessagingServiceOptions`: `RetryLimit` (5), `MinRetryInterval` (1 s), `RetryIntervalDelta` (5 s) and `MaxRetryInterval` (1 min), turned into pauses by:

```csharp
public IReadOnlyList<TimeSpan> RetryIntervals()
    => Enumerable.Range(0, RetryLimit)
        .Select(attempt => MinRetryInterval + RetryIntervalDelta * (Math.Pow(2, attempt) - 1))
        .Select(interval => interval < MaxRetryInterval ? interval : MaxRetryInterval)
        .ToList();
```

`BusTopology.cs` plugs it into Wolverine's [error handling](https://wolverinefx.net/guide/handlers/error-handling.html):

```csharp
wolverine
    .OnAnyException()
    .RetryWithCooldown([.. options.RetryIntervals()])
    .Then.MoveToErrorQueue();
```

With the defaults, the pauses are **1 s, 6 s, 16 s, 36 s and 1 min**, so one message can be handled **up to six times** before it lands in the error queue.

One integration event usually has several handlers, from several modules, and the consumer runs every one of them. Here is the heart of `IntegrationEventDispatcher` (logging omitted):

```csharp
foreach (var handler in handlers)
{
    try
    {
        await handler.HandleAsync(@event, cancellationToken);
    }
    catch (Exception ex)
    {
        (failures ??= []).Add(ex);
    }
}

if (failures is not null)
{
    // Retried as a whole, so every handler has to tolerate having already run.
    throw new AggregateException(
        $"{failures.Count} handler(s) failed for event {messageType} with MessageId {id}.",
        failures);
}
```

Failures are aggregated, so one broken handler does not stop the others, but on a retry **every** handler runs again. An `organization.member_removed` event, for example, is handled by the Workspaces domain and by the Webhooks module: if the Workspaces handler fails once, the Webhooks handler queues its deliveries twice.

> **_Note:_**  Wolverine's [durable inbox](https://wolverinefx.net/guide/durability/idempotency.html) discards a message the broker delivers twice, but a retry after a failure is meant to run the handlers again. Whatever the transport, the fix belongs in the handler.


## The one thing that stays the same: the message id
Wolverine keeps the same **envelope id** for every redelivery, which the messaging adapter's `ConsumerTests` assert. That id is our idempotency key. A domain handler should not depend on Wolverine to read it, so a small port in `Blouppy.Infrastructure.Messaging.Abstractions` exposes it:

```csharp
namespace Blouppy.Infrastructure.Messaging.Abstractions;

// The message id stays the same across redeliveries, so handlers derive idempotent keys from it.
public interface IIntegrationEventContext
{
    Guid? MessageId { get; }
}
```

The messaging adapter, the only place that knows about Wolverine, implements it over Wolverine's `IMessageContext`:

```csharp
// Inside a consumer the scope's context is the delivery's, primed by ConsumerMessageHandler; outside one it has none.
internal sealed class IntegrationEventContext(
    IMessageContext messageContext) : IIntegrationEventContext
{
    public Guid? MessageId
        => messageContext.Envelope?.Id;
}
```

It is registered as **scoped**. The consumer creates a DI scope per delivery and primes the scoped `IMessageContext` with it, so inside a consumer `Envelope.Id` is the message id; outside one (a controller, a job), `MessageId` is `null`.


## Derive the row id from the message id
The Webhooks module's dispatcher writes one `WebhookDelivery` row per subscribed webhook. Instead of drawing a random id, it computes one:

```csharp
// Derived from the message id so a redelivered message finds the rows it already wrote.
internal static WebhookDeliveryId CreateDeliveryId(Guid? messageId, WebhookId webhookId)
{
    if (messageId is null)
    {
        return WebhookDeliveryId.Create();
    }

    var hash = SHA256.HashData(Encoding.UTF8.GetBytes($"{messageId.Value:N}:{webhookId.Value}"));

    return new WebhookDeliveryId(new Guid(hash.AsSpan(0, 16)).ToString("N"));
}
```

- **The input is the pair (message id, webhook id)**, because one message fans out to several webhooks, and each needs its own row.
- [`SHA256.HashData`](https://learn.microsoft.com/dotnet/api/system.security.cryptography.sha256.hashdata) turns the pair into 32 bytes that are always the same for the same input. A hash rather than the raw string keeps the id fixed-size and opaque, which matters since subscribers see it.
- [`new Guid(hash.AsSpan(0, 16))`](https://learn.microsoft.com/dotnet/api/system.guid.-ctor) keeps the first 16 bytes. Formatted with `"N"`, that is 32 hexadecimal characters, the same shape as `WebhookDeliveryId.Create()` (`Guid.NewGuid().ToString("N")`) and the column's `MaxLength` of 32.
- **No message, no determinism.** Without a message id, there is nothing to deduplicate against, so the dispatcher falls back to a random id.

The database must not generate the key: `WebhookDeliveryConfiguration` marks it [`ValueGeneratedNever()`](https://learn.microsoft.com/ef/core/modeling/generated-properties).


## Skip what is already written
With deterministic ids, the dispatcher can ask "which of these rows do I already have?" before writing. Here is the core of `WebhookEventDispatcher.DispatchAsync` (logging omitted):

```csharp
var messageId = integrationEventContext.MessageId;

var candidates = webhooks
    .Select(webhook => (WebhookId: webhook.Id, DeliveryId: CreateDeliveryId(messageId, webhook.Id)))
    .ToArray();

var alreadyQueued = await webhookDeliveriesRepository.GetExistingIdsAsync(
    candidates.Select(candidate => candidate.DeliveryId).ToArray(),
    cancellationToken);

var deliveries = new List<WebhookDelivery>(candidates.Length);

foreach ((WebhookId webhookId, WebhookDeliveryId deliveryId) in candidates)
{
    if (alreadyQueued.Contains(deliveryId))
    {
        continue;
    }

    var payload = Serialize(deliveryId, organizationId, eventType, data);

    var delivery = new WebhookDelivery(deliveryId, webhookId, eventType, payload);

    await webhookDeliveriesRepository.AddAsync(delivery, cancellationToken);

    deliveries.Add(delivery);
}

if (deliveries.Count == 0)
{
    return;
}

// Commit before publishing: inside a consumer the bus outbox does not cover the publish.
await unitOfWork.CommitAsync(cancellationToken);

// ...then one WebhookDeliveryRequestedIntegrationEvent per new delivery.
```

`GetExistingIdsAsync`, in `WebhookDeliveriesRepository`, is one round trip whatever the number of webhooks, the `Contains` becoming a single `IN`/`ANY` filter in PostgreSQL:

```csharp
return await dbContext.WebhookDeliveries
    .Where(x => ids.Contains(x.Id))
    .Select(x => x.Id)
    .ToArrayAsync(cancellationToken);
```

When every row already exists, the method returns before committing and before publishing, so a retry does not trigger a second HTTP call either.

What if two attempts run at the same time? The check-then-insert is not atomic, but the primary key is: the slower insert violates it, that attempt fails and is retried, and the retry finds the rows.


## Give the same id to the subscriber
A webhook subscriber also lives in an at-least-once world: our sender retries, and a person can redeliver by hand. The dispatcher writes `deliveryId.Value` into the `Delivery` property of the `WebhookEventEnvelope` that is signed and sent. The same value travels in the `X-Blouppy-Delivery` header, but the envelope repeats it because "headers are not signed". A subscriber deduplicates on `delivery` and can trust it, since the signature covers it. [Signed outgoing webhooks in ASP.NET Core](https://www.blouppy.com/blog/2026-09-19-signed-outgoing-webhooks-in-aspnet-core/) covers the signature.


## Test it
A pure function is trivial to test: `WebhookEventDispatcherTests` asserts that the same message and webhook give the same 32-character id, that two messages give two ids, and that no message gives a random one. The behaviour test, `Should_not_queue_a_second_delivery_when_the_same_message_is_handled_again`, mocks `IIntegrationEventContext` to return a fixed message id, dispatches twice, and asserts that a single row was added and that the second run neither published nor committed. No broker, no Wolverine, just a mocked `MessageId`.


## Other ways to be idempotent
Deterministic ids are one tool. The same code base uses two others, which show when *not* to reach for a hash.

### Store the message id itself
The audit log records one entry per consumed fact. It keeps the message id in a `SourceMessageId` column, with a unique index on `(SourceMessageId, OrganizationId)`, and checks it before inserting. It makes the opposite choice for the "no message" case, in `AuditEntryRecorder`:

```csharp
var messageId = integrationEventContext.MessageId
    ?? throw new InvalidOperationException($"An audit entry is only recorded from a consumed message, and {eventType} came without one.");
```

A webhook can legitimately be dispatched outside a consumer, so it falls back to a random id. An audit entry only ever comes from a message, so a missing id is a bug, and it fails loudly.

### Make the write naturally idempotent
Some handlers project the latest state rather than append a fact. The Organizations domain keeps a local copy of the entitlements the Billing module publishes, with an upsert, and the entity ignores older values:

```csharp
// In OrganizationEntitlements.Update(...), before any limit is copied:
// Events can arrive out of order; never let an older one win.
if (updatedAt < UpdatedAt)
{
    return;
}
```

Applying the same event twice gives the same row, so no key is needed. The timestamp also solves a problem deterministic ids do not: **ordering**. The rule of thumb:
- **The handler appends facts** (deliveries, entries, notifications): key the rows on the message.
- **The handler mirrors state**: upsert, and let the newest version win.


## Conclusion
With at-least-once delivery, a handler runs again whenever *any* handler for the same message fails. The message id stays the same across retries, and `IIntegrationEventContext` hands it to the domain without leaking the bus library.

Hash the message id with whatever makes each row unique, keep 16 bytes as the row's id, find the existing ids in one query, write only the missing rows, and send the same id onward so the next hop can deduplicate too.

This is how the webhook dispatch of [Blouppy Starter](https://starter.blouppy.com/) stays idempotent across retries; the [Webhooks module page](https://docs.starter.blouppy.com/modules/webhooks/) describes the full delivery pipeline.


## References
- [Wolverine: Error handling](https://wolverinefx.net/guide/handlers/error-handling.html) — retry policies, cooldowns and the error queue.
- [Wolverine: Idempotent message delivery](https://wolverinefx.net/guide/durability/idempotency.html) — what the durable inbox deduplicates.
- [Wolverine: Idempotency in messaging](https://wolverinefx.net/tutorials/idempotency.html) — the tutorial on idempotent handlers.
- [SHA256.HashData method](https://learn.microsoft.com/dotnet/api/system.security.cryptography.sha256.hashdata) — one-shot hashing.
- [Guid constructors](https://learn.microsoft.com/dotnet/api/system.guid.-ctor) — building a `Guid` from 16 bytes.
- [Generated values](https://learn.microsoft.com/ef/core/modeling/generated-properties) — `ValueGeneratedNever()` for keys set by the application.
- [RabbitMQ: Reliability guide](https://www.rabbitmq.com/docs/reliability) — acknowledgements, redelivery and at-least-once delivery.
- [Idempotent Receiver](https://www.enterpriseintegrationpatterns.com/patterns/messaging/IdempotentReceiver.html) — the Enterprise Integration Patterns entry.
- [Blouppy Starter: Webhooks](https://docs.starter.blouppy.com/modules/webhooks/) — the delivery pipeline this article comes from.
