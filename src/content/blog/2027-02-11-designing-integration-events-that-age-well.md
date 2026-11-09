---
templateKey: 'blog-post'
title: 'Designing integration events that age well in .NET'
date: 2027-02-11T09:00:00.000Z
author: Jimmy Boinembalome
authorimage: /img/jimmy.jpg
category: C#
topic: 'Messaging'
illustration: 2
categorycolor: bg-purple-100 text-purple-800
featuredpost: true
description: >-
  Learn how to design integration events as a public contract in .NET: past-tense facts, thin or fat payloads, the actor, safe versioning and consumers that survive redelivery.
tags:
  - Development
  - C#
  - Wolverine
  - Architecture
---

The first integration event of a project is easy to write: a record with an id, a publisher, a handler. A year later, the same record has three consumers in two processes. Messages from last week's version still sit in the outbox during a deploy. Renaming one property breaks a host nobody redeployed.

An integration event is a **public contract**, like an HTTP API. Its clients are other modules and other processes, and its messages outlive the code that wrote them. The examples here come from [Blouppy Starter](https://starter.blouppy.com/), which runs on Wolverine and RabbitMQ with a transactional outbox. How that outbox publishes is the subject of [domain events vs integration events](/blog/2026-05-28-domain-events-vs-integration-events-and-the-outbox/); here we look at the contract itself.


## Name a fact, in the past tense
An integration event says that something **happened**. It is not an order, so its name is a past-tense verb on a noun of the producer's language: `OrganizationDeletedIntegrationEvent`, not `CancelSubscription`.

The Organizations domain does not know that Billing will cancel a subscription when it hears of it. It states the fact, and each consumer decides what the fact means for it. A command would tie the producer to one consumer and one reaction. A fact lets a second consumer subscribe without touching the producer.

Handlers follow the same grammar: `CancelSubscriptionWhenOrganizationDeletedIntegrationEventHandler`. Long, but a file listing reads as a list of rules.


## Carry what will not resolve later
A **thin** event carries ids only, and a consumer that needs more asks the producer. A **fat** event carries the data the consumers need. A thin event forces a call back to a producer that may be down, or may have deleted what the id pointed to. A fat event couples consumers to more fields.

The Starter picks per event, by asking one question: **will the id still resolve when the consumer reads it?** `OrganizationDeletedIntegrationEvent` carries one id, because Billing finds the subscription by organization id in its own schema. A deleted workspace is different:

```csharp
/// <summary>A workspace was deleted, with everything in it. Its name is a snapshot: nothing resolves its id any more.</summary>
public sealed record WorkspaceDeletedIntegrationEvent(
    OrganizationId OrganizationId,
    WorkspaceId WorkspaceId,
    string WorkspaceName,
    AuditActor Actor,
    DateTimeOffset OccurredAt) : IAuditableIntegrationEvent;
```

Two more fields deserve a place in most events. `Actor` says who made the change: the consumer runs off the request, often in another process, where there is no current user. The producer fills it with `AuditActor.Of(currentUserService)` at the moment of the change, and as a required positional parameter it cannot be forgotten. `OccurredAt` says when, because the consumer's clock only says when the message arrived ([an audit log that can't lie](/blog/2026-09-07-an-audit-log-that-cant-lie/)).

What an event leaves out matters too. A message sits in an outbox table, a broker and an error queue, and may be logged on the way. A secret in it is copied to all of those places. That is why the Starter's webhook events carry the URL without its query string, and header names without their values.


## The name of the type is part of the contract
The Starter's events live in the messaging port, `Blouppy.Infrastructure.Messaging.Abstractions`, which depends on the shared kernel only. An event can carry a typed id, never a domain model.

There is a trap here. The Starter names each RabbitMQ exchange after the message type, with Wolverine's `ToMessageTypeName()`, which by default is the type's full name. **The namespace and the class name are part of the contract.** Moving the record to a tidier folder, with a namespace to match, creates a new exchange on the next deploy. A consumer still bound to the old one stops receiving messages, with no error anywhere.

Between the API and the identity host, deployed separately, the Starter adds a wire shape: a record of primitives, declared on both sides under the same full name. Neither host references the other's code.


## Add, never rename
During a rolling update, the outbox and the queues still hold messages written by the previous version. A change to an event must be readable in both directions. The rules:

- **Add fields at the end, with a default.** An older message still deserializes, and gets the default.
- **Choose the default for safety.** It is what an old message means from now on.
- **Never rename or remove a field.** A renamed field is a removed field plus a new one.
- **A new meaning is a new type.** If `Deleted` starts meaning *archived*, every existing consumer silently does the wrong thing.

The entitlements event that Billing publishes shows the second rule well:

```csharp
public sealed record OrganizationEntitlementsChangedIntegrationEvent(
    OrganizationId OrganizationId,
    int? MaxWorkspaces,
    DateTimeOffset EffectiveAtUtc,
    bool AllowsOwnAiKey = false,
    int? MonthlyAiCredits = null,
    int? MonthlyAiCreditsPerMember = null,
    int? MonthlyAutomationAiCredits = 0,
    bool AllowsSso = false) : IIntegrationEvent;
```

In this event, `null` means unlimited. For `MonthlyAiCredits`, an old message reading as `null` is acceptable, since each person's own allowance still bounds the use. For `MonthlyAutomationAiCredits`, the pool for AI work that runs on its own, unlimited would be an open tap. So an old message reads as `0`, nothing automatic, until the next event sets the real figure. Two defaults, each chosen for what it does to an old message.


## Late, twice, or out of order
A bus with an outbox delivers **at least once**. A handler can run twice for the same message, and two messages about the same thing can arrive in either order. The event can help with both.

The entitlements event carries the **whole state**, not a delta, so a consumer that missed one is corrected by the next. And it carries `EffectiveAtUtc`, so the projection can refuse to go back in time. Simplified:

```csharp
public void Update(int? maxWorkspaces, DateTimeOffset updatedAt)
{
    // Events can arrive out of order; never let an older one win.
    if (updatedAt < UpdatedAt)
    {
        return;
    }

    MaxWorkspaces = maxWorkspaces;
    UpdatedAt = updatedAt;
}
```

For redelivery, a fact makes the handler easier: "make it true" repeats safely. The identity host's handler for an erased account treats an identity already gone as a success. A handler that writes rows needs a key that stays the same across retries, derived from the message id ([idempotent message handlers](/blog/2026-08-20-idempotent-message-handlers-with-deterministic-ids/)).

None of this is needed when messages never outlive a deploy: one process, deployed as one unit, with no durable queue. There, renaming a field is a refactoring like any other.


## References
- [Wolverine: Message type name](https://wolverinefx.net/guide/messages.html) — how Wolverine identifies a message type on the wire.
- [Wolverine: Transactional outbox](https://wolverinefx.net/guide/durability/) — durable inbox and outbox, and at-least-once delivery.
- [What do you mean by "Event-Driven"?](https://martinfowler.com/articles/201701-event-driven.html) — Martin Fowler on event notification and event-carried state transfer.
