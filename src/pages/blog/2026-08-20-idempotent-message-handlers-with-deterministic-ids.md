---
templateKey: 'blog-post'
title: 'Idempotent message handlers in .NET: deterministic IDs from the message ID'
date: 2026-08-20T09:00:00.000Z
author: Jimmy Boinembalome
authorimage: /img/jimmy.jpg
category: C#
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

A message broker almost never promises "exactly once". It promises **at least once**: if a handler throws, the message comes back, and it comes back as a whole. When several handlers react to the same event, a failure in *any* of them replays *all* of them. So a handler that inserts a row with `Guid.NewGuid()` on every attempt quietly writes a duplicate on every retry, even though it succeeded the first time.

In this article, we will make such a handler idempotent without a locking table or a deduplication cache: we will derive the id of each row from the id of the bus message, so that a retry recomputes the same ids, finds its rows already there, and adds nothing.


## Why the handler runs again
Let's start with the retry policy, because it decides how many times our handler will see the same message. In the code base this comes from, the bus is Wolverine, and the policy is plain options:

```csharp
public sealed class MessagingServiceOptions
{
    public int RetryLimit { get; set; } = 5;

    public TimeSpan MinRetryInterval { get; set; } = TimeSpan.FromSeconds(1);

    public TimeSpan MaxRetryInterval { get; set; } = TimeSpan.FromMinutes(1);

    public TimeSpan RetryIntervalDelta { get; set; } = TimeSpan.FromSeconds(5);

    public IReadOnlyList<TimeSpan> RetryIntervals()
        => Enumerable.Range(0, RetryLimit)
            .Select(attempt => MinRetryInterval + RetryIntervalDelta * (Math.Pow(2, attempt) - 1))
            .Select(interval => interval < MaxRetryInterval ? interval : MaxRetryInterval)
            .ToList();
}
```

And here is where it is plugged into the bus (`BusTopology.cs`):

```csharp
wolverine
    .OnAnyException()
    .RetryWithCooldown([.. options.RetryIntervals()])
    .Then.MoveToErrorQueue();
```

- With the defaults, the pauses are **1 s, 6 s, 16 s, 36 s and 1 min** (a unit test, `MessagingServiceOptionsTests`, pins exactly that list).
- So one message can be handled **up to six times** before it lands in the error queue.

Now, who triggers those retries? Not only our handler. One integration event usually has several handlers, from several modules, and the consumer runs every one of them. Here is the heart of `IntegrationEventDispatcher`:

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

Failures are aggregated rather than short-circuited, so one broken handler does not stop the others. The price is in the comment: on a retry, **every** handler runs again. A concrete example from the code base: an `organization.member_removed` event is handled by the Workspaces domain (it drops the member's team memberships) and by the Webhooks module (it queues one delivery per subscribed webhook). If the Workspaces handler fails once, the Webhooks handler runs twice.

> **_Note:_**  This is the normal life of an at-least-once system. The fix belongs in the handler.


## The one thing that stays the same: the message id
What does a redelivered message have in common with the first attempt? Its payload, of course, but also its **envelope id**. Wolverine keeps the same id for every redelivery of a message, and an integration test of the messaging adapter (`ConsumerTests`) asserts it explicitly, "every redelivery keeps the message's id, which handlers derive their idempotency keys from".

So the message id is our idempotency key. But a domain handler should not depend on Wolverine to read it. Let's expose it through a tiny port, in `Blouppy.Infrastructure.Messaging.Abstractions`:

```csharp
namespace Blouppy.Infrastructure.Messaging.Abstractions;

// The message id stays the same across redeliveries, so handlers derive idempotent keys from it.
public interface IIntegrationEventContext
{
    Guid? MessageId { get; }
}
```

And here is its implementation, in the messaging adapter, the only place that knows about Wolverine:

```csharp
// Inside a consumer the scope's context is the delivery's, primed by ConsumerMessageHandler; outside one it has none.
internal sealed class IntegrationEventContext(
    IMessageContext messageContext) : IIntegrationEventContext
{
    public Guid? MessageId
        => messageContext.Envelope?.Id;
}
```

It is registered as **scoped** (`services.TryAddScoped<IIntegrationEventContext, IntegrationEventContext>()`):

- The consumer creates a DI scope per delivery and primes Wolverine's scoped `IMessageContext` with the delivery's context, so inside a consumer `Envelope.Id` is the message id.
- Outside a consumer (a controller, a background job), there is no envelope, so `MessageId` is `null`. The nullable type is honest: "there is no message to be idempotent against".


## Derive the row id from the message id
Now the handler itself. The Webhooks module's dispatcher writes one `WebhookDelivery` row per subscribed webhook. Instead of drawing a random id, it computes one:

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

Let's go through it:

- **The input is the pair (message id, webhook id).** One message fans out to several webhooks, and each needs its own row.
- **`SHA256.HashData`** turns that pair into 32 bytes that are the same every time for the same input, and different for any other input.
- **`new Guid(hash.AsSpan(0, 16))`** keeps the first 16 bytes, which is exactly the size of a `Guid`. Formatted with `"N"`, it is 32 hexadecimal characters, the same shape as `WebhookDeliveryId.Create()` (`Guid.NewGuid().ToString("N")`) and the same `MaxLength` of 32 for the column.
- **No message, no determinism.** When `messageId` is `null`, the dispatcher falls back to a random id. There is nothing to deduplicate against, and inventing a key would be worse than having none.

> **_Note:_**  Why a hash rather than `$"{messageId}:{webhookId}"` itself? The id is shown to the outside world (we'll see where), and a hash keeps it fixed-size and opaque. 😉

The only requirement on the database side is that the key is not generated there: in `WebhookDeliveryConfiguration`, the id is the primary key, with `ValueGeneratedNever()`.


## Skip what is already written
With deterministic ids, the dispatcher can ask "which of these rows do I already have?" before writing anything. Here is the relevant part of `WebhookEventDispatcher.DispatchAsync`:

```csharp
var messageId = integrationEventContext.MessageId;

var candidates = webhooks
    .Select(webhook => (WebhookId: webhook.Id, DeliveryId: CreateDeliveryId(messageId, webhook.Id)))
    .ToArray();

var alreadyQueued = await webhookDeliveriesRepository.GetExistingIdsAsync(
    candidates.Select(candidate => candidate.DeliveryId).ToArray(),
    cancellationToken);

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
```

And `GetExistingIdsAsync` (in `WebhookDeliveriesRepository`) is one query, whatever the number of webhooks:

```csharp
return await dbContext.WebhookDeliveries
    .Where(x => ids.Contains(x.Id))
    .Select(x => x.Id)
    .ToArrayAsync(cancellationToken);
```

- **One round trip** for all the candidates: the `Contains` becomes a single `IN`/`ANY` filter in PostgreSQL.
- **Nothing to do, nothing published.** When every row exists, the method returns before committing and before publishing the follow-up messages, so a retry does not trigger a second HTTP call either.

What if two attempts run at the same time? The check-then-insert is not atomic, but the primary key is: the slower insert violates it, that attempt fails and is retried, and the retry finds the rows.


## Give the same id to the subscriber
Idempotency does not stop at our database. A webhook subscriber also lives in an at-least-once world: our own sender retries failed attempts, and a person can redeliver a delivery by hand. So the subscriber needs a key too, and we already have a stable one.

The deterministic id is written into the envelope that is signed and sent:

```csharp
var envelope = new WebhookEventEnvelope
{
    Event = eventType.ToWireName(),
    Delivery = deliveryId.Value,
    OrganizationId = organizationId.Value,
    OccurredAt = DateTimeOffsetProvider.UtcNow,
    Data = data
};
```

The same value travels in the `X-Blouppy-Delivery` header, but the envelope's comment explains why it is repeated in the body: "headers are not signed". A subscriber deduplicates on `delivery`, and it can trust it because it is covered by the signature. How the signature itself is built is covered in [Signed outgoing webhooks in ASP.NET Core](https://www.blouppy.com/blog/2026-09-19-signed-outgoing-webhooks-in-aspnet-core/).


## Test it
The nice thing about a pure function is that it is trivial to test. Here are two of the unit tests in `WebhookEventDispatcherTests`:

```csharp
[Fact]
public void Should_derive_the_same_delivery_id_when_the_message_and_webhook_are_the_same()
{
    // Arrange
    var messageId = Guid.NewGuid();

    // Act
    var first = WebhookEventDispatcher.CreateDeliveryId(messageId, new WebhookId(1));
    var second = WebhookEventDispatcher.CreateDeliveryId(messageId, new WebhookId(1));

    // Assert
    second.Should().Be(first);
    first.Value.Should().HaveLength(WebhookDeliveryId.MaxLength);
}

[Fact]
public void Should_draw_a_random_delivery_id_when_there_is_no_message()
{
    // Act
    var first = WebhookEventDispatcher.CreateDeliveryId(messageId: null, new WebhookId(1));
    var second = WebhookEventDispatcher.CreateDeliveryId(messageId: null, new WebhookId(1));

    // Assert
    second.Should().NotBe(first);
}
```

And the behaviour test, `Should_not_queue_a_second_delivery_when_the_same_message_is_handled_again`, mocks `IIntegrationEventContext` to return a fixed message id, dispatches twice, and asserts that a single row was added, that nothing was published and that nothing was committed the second time. No broker, no Wolverine, just a mocked `MessageId`. 👍


## Other ways to be idempotent
Deterministic ids are one tool, not the only one. The same code base shows two others, and they teach when *not* to reach for a hash.

### Store the message id itself
The audit log records one entry per consumed fact. It does not derive an id; it keeps the message id in a `SourceMessageId` column, with a unique index on `(SourceMessageId, OrganizationId)`, and checks it before inserting. Notice the opposite choice for the "no message" case in `AuditEntryRecorder`:

```csharp
var messageId = integrationEventContext.MessageId
    ?? throw new InvalidOperationException($"An audit entry is only recorded from a consumed message, and {eventType} came without one.");
```

A webhook can legitimately be dispatched outside a consumer, so it falls back to a random id. An audit entry only ever comes from a message, so a missing id is a bug, and it fails loudly.

### Make the write naturally idempotent
Some handlers do not insert a new fact; they project the latest state. The Organizations domain keeps a local copy of the entitlements the Billing module publishes, with an upsert, and the entity refuses older values:

```csharp
public void Update(
    int? maxWorkspaces,
    // ... the other limits
    DateTimeOffset updatedAt,
    bool allowsSso = false)
{
    // Events can arrive out of order; never let an older one win.
    if (updatedAt < UpdatedAt)
    {
        return;
    }

    MaxWorkspaces = maxWorkspaces;
    // ...
    UpdatedAt = updatedAt;
}
```

Applying the same event twice gives the same row, so no key is needed at all. And the timestamp handles a problem deterministic ids do not solve: **ordering**. The rule of thumb:

- **The handler appends facts** (deliveries, entries, notifications): key the rows on the message.
- **The handler mirrors state**: upsert, and let the newest version win.


## Conclusion
With at-least-once delivery, a handler runs again whenever *any* handler for the same message fails, so "it worked the first time" is not enough. The message id is the one thing that stays the same across retries, and a small scoped port, `IIntegrationEventContext`, hands it to the domain without leaking the bus library.

From there, the recipe fits in a few lines: hash the message id with whatever makes each row unique, keep 16 bytes as the row's id, check which ids already exist in one query, and write only the missing ones. Fall back to a random id when there is no message, and send the same id to the outside world so that the next hop can deduplicate too. When the handler mirrors state rather than appending facts, an upsert guarded by a timestamp is simpler and also survives out-of-order events.

This is how the webhook dispatch of [Blouppy Starter](https://starter.blouppy.com/) stays idempotent across retries; its [Webhooks module page](https://docs.starter.blouppy.com/modules/webhooks/) describes the full delivery pipeline.

*Thanks for reading! 🙂*
