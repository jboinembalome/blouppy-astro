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

The first integration event of a project is easy to write. A record with an id, a publisher, a handler, done. A year later, the same record has three consumers in two processes, messages from last week's version still sit in the outbox during a deploy, and renaming one property breaks a host nobody redeployed.

An integration event is a **public contract**, like an HTTP API, except that its clients are other modules and other processes, and the messages outlive the code that wrote them. In this article, we will look at how to design one so that it ages well: naming it as a fact, deciding what goes in it, capturing who did it, where the type lives, how to change it without breaking anyone, and what its consumers must tolerate. The examples come from [Blouppy Starter](https://starter.blouppy.com/), which runs on Wolverine and RabbitMQ with a transactional outbox.

The difference between a domain event and an integration event, and how the outbox publishes one, is the subject of [Domain events vs integration events in .NET, and the transactional outbox](/blog/2026-05-28-domain-events-vs-integration-events-and-the-outbox/). Here, we take that for granted and focus on the contract itself.


## Name a fact, in the past tense
An integration event says that something **happened**. It is not an order to do something, so its name is a past-tense verb on a noun of the producer's language:

```csharp
public sealed record OrganizationDeletedIntegrationEvent(
    OrganizationId OrganizationId) : IIntegrationEvent;

public sealed record AccountErasedIntegrationEvent(
    UserId UserId) : IIntegrationEvent;
```

`OrganizationDeleted`, not `CancelSubscription`. The Organizations domain does not know that Billing will cancel a subscription when it hears of it, nor that the identity host will forget the organization's single sign-on. It states the fact, and each consumer decides what the fact means for it. A command (`CancelSubscription`) would couple the producer to one consumer and one reaction; a fact lets a second consumer subscribe without touching the producer.

Even a request can be phrased as a fact. When an administrator asks for a new plan, Billing publishes `SubscriptionPlanChangeRequestedIntegrationEvent`: *a request was made*, which is true whether or not the payment provider accepts it later.

The handlers follow the same grammar, `<Reaction>When<Event>IntegrationEventHandler`:

- `CancelSubscriptionWhenOrganizationDeletedIntegrationEventHandler` in Billing.
- `DeleteIdentityWhenAccountErasedIntegrationEventHandler` in the identity host.
- `DispatchWebhooksWhenOrganizationMemberRemovedIntegrationEventHandler` in Webhooks.

The names are long, but a file listing reads as a list of rules, and a search on the event name finds every reaction to it.


## Thin or fat: what goes in the payload
There are two schools. A **thin** event carries ids only, and a consumer that needs more asks the producer. A **fat** event (often called *event-carried state transfer*) carries the data the consumers need, so they never call back.

Both have a cost. A thin event forces a call back to the producer, which may be down, or may already have changed or deleted what the id pointed to. A fat event couples every consumer to more fields, leaks more data into queues and logs, and grows with each new consumer's wish.

The Starter picks per event, by asking one question: **will the id still resolve when the consumer reads it?**

- `OrganizationDeletedIntegrationEvent` and `AccountErasedIntegrationEvent` carry one id. Billing looks the subscription up by organization id in its own schema; the identity host looks the user up in its own database. Nothing needs to be fetched from the producer.
- `WorkspaceDeletedIntegrationEvent` carries the name too, because once the workspace is deleted, nothing resolves its id any more:

```csharp
/// <summary>A workspace was deleted, with everything in it. Its name is a snapshot: nothing resolves its id any more.</summary>
public sealed record WorkspaceDeletedIntegrationEvent(
    OrganizationId OrganizationId,
    WorkspaceId WorkspaceId,
    string WorkspaceName,
    AuditActor Actor,
    DateTimeOffset OccurredAt) : IAuditableIntegrationEvent;
```

- `OrganizationEntitlementsChangedIntegrationEvent` is fat on purpose: it carries the **whole state** of what the organization is entitled to, so the Organizations domain keeps a local projection and never calls Billing on the hot path. Because it carries the full state rather than a delta, a consumer that missed one event is corrected by the next.

What a fat event leaves out matters as much as what it carries. `WebhookUpdatedIntegrationEvent` carries a before and after snapshot of the settings, and the snapshot type says what it refuses to hold:

```csharp
/// <summary>
/// A webhook's settings as the audit log may record them: the URL without user-info, query string or fragment,
/// the event types by wire name, and the custom headers by name — never a value, never the secret.
/// </summary>
public sealed record WebhookSettingsSnapshot(
    string Url,
    IReadOnlyList<string> Events,
    bool IsActive,
    IReadOnlyList<string> HeaderNames);
```

A message sits in an outbox table, a broker and an error queue, and may be logged on the way. Anything secret in it is copied to all of those places.


## Capture the actor where the change is made
A consumer runs off the request, often in another process, where there is no current user. If the event does not say who made the change, nobody can say it later. The Starter's audited events implement `IAuditableIntegrationEvent`, which exposes `Actor`, `OrganizationId` and `OccurredAt`, and the producer fills `Actor` with `AuditActor.Of(currentUserService)` at the moment of the change:

```csharp
public interface IAuditableIntegrationEvent : IIntegrationEvent
{
    AuditActor Actor { get; }

    OrganizationId? OrganizationId { get; }

    DateTimeOffset OccurredAt { get; }
}
```

`Actor` is a required positional parameter of each event record, so a publisher cannot forget it, and changes nobody's request makes use `AuditActor.System` or `AuditActor.Erasure`. The same reasoning applies to `OccurredAt`: the consumer's clock tells when the message arrived, not when the change happened. How the audit module turns these events into entries is covered in [An audit log that can't lie](/blog/2026-09-07-an-audit-log-that-cant-lie/).


## Where the types live
All of the Starter's integration events live in one project, `Blouppy.Infrastructure.Messaging.Abstractions`, in a folder per producer (`Organizations/`, `Privacy/`, `Billing/`, `Webhooks/`...). It is the messaging port: producers and consumers reference it, and neither references the other. The project depends on the shared kernel only, so an event can carry a typed id such as `OrganizationId`, never a domain model.

Inside one process, that is enough. Between two hosts, the API and the identity host, the Starter adds a **wire shape**: a record made of primitives, and a mapper on each side.

```csharp
// The namespace is part of the exchange name, so it stays short and identical on both hosts.
namespace Blouppy.Infrastructure.Messaging.Privacy;

internal sealed record AccountErasedIntegrationEventDto(
    string UserId) : IMessage;

internal sealed class AccountErasedEventMapper
    : IIntegrationEventMapper<AccountErasedIntegrationEvent, AccountErasedIntegrationEventDto>
{
    public AccountErasedIntegrationEventDto MapToMessage(AccountErasedIntegrationEvent @event)
        => new(UserId: @event.UserId.Value);

    public AccountErasedIntegrationEvent MapToEvent(AccountErasedIntegrationEventDto message)
        => new(UserId: new UserId(message.UserId));
}
```

The identity host declares the same record, under the same namespace and name, and consumes it directly. Neither host references the other's code; they agree on a shape.

That detail is the trap to know about. The Starter names each RabbitMQ exchange after the message type, with Wolverine's `ToMessageTypeName()`, which by default is the type's full name. **The namespace and the class name are part of the contract.** Moving the record to a tidier folder, with a namespace to match, creates a new exchange on the next deploy, and a consumer still bound to the old one stops receiving messages, with no error anywhere.


## Versioning: add, never rename
Messages outlive deploys. During a rolling update, the outbox and the queues still hold messages written by the previous version, and a host that was not redeployed still writes them. A change to an event must therefore be readable in both directions.

The rules the Starter follows:

- **Add fields at the end, with a default.** A message without the field still deserializes, and gets the default.
- **Choose the default for safety, not convenience.** It is what an old message means from now on.
- **Never rename or remove a field.** A renamed field is a removed field plus a new one, and the old messages carry the old name.
- **A new meaning is a new event type.** If `Deleted` starts meaning *archived*, every existing consumer silently does the wrong thing. `OrganizationArchivedIntegrationEvent` would leave them alone.

`OrganizationEntitlementsChangedIntegrationEvent` shows the second rule well:

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

In this event, `null` means unlimited. For `MonthlyAiCredits`, an old message reading as `null` is acceptable, since each person's allowance still bounds the use. For `MonthlyAutomationAiCredits`, the pool for AI work that runs on its own, the code comment calls an unlimited pool "an open tap": an old message reads as `0`, nothing automatic, until the next event sets the real figure. Same type, same position at the end, two different defaults, each chosen for what it does to an old message. The [billing module article](/blog/2026-10-01-billing-module-behind-an-adapter/) shows where this event comes from.


## Consumers that tolerate redelivery and reordering
A bus with an outbox delivers **at least once**. A handler can run twice for the same message, and two messages about the same thing can arrive in either order. The event design helps the consumer with both.

For **reordering**, a state-carrying event needs a timestamp of the change. `EffectiveAtUtc` is that field, and the projection refuses to go back in time:

```csharp
public void Update(
    int? maxWorkspaces,
    // ... the other entitlements
    DateTimeOffset updatedAt)
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

Without the timestamp in the event, the consumer could only trust the order of arrival, which nothing guarantees.

For **redelivery**, a thin fact makes the handler easier to write, because "make it true" is naturally repeatable. Billing's handler stops early when there is no subscription or when it is already canceled, and the identity host's handler treats an identity already gone as a success:

```csharp
var user = await identityService.FindByIdAsync(@event.UserId);

if (user is null)
{
    logger.LogInformation("Identity {UserId} is already gone; nothing to delete", @event.UserId);

    return;
}
```

When a handler writes rows instead, it needs a key that stays the same across retries: [Idempotent message handlers in .NET](/blog/2026-08-20-idempotent-message-handlers-with-deterministic-ids/) derives it from the message id.


## One event, many readers
In the Starter, the consumer base class runs **every** handler registered for an event, not just one. `OrganizationMemberRemovedIntegrationEvent` is recorded by the audit module and dispatched by the Webhooks module, and neither knows about the other.

The Webhooks handler does not forward the integration event to customers. It translates it into the webhook's own payload:

```csharp
return webhookEventDispatcher.DispatchAsync(
    @event.OrganizationId,
    WebhookEventType.OrganizationMemberRemoved,
    new WebhookEventData.OrganizationMember(MemberId: @event.MemberId.Value),
    cancellationToken);
```

This keeps two contracts apart. The integration event is internal: we own every consumer and can redeploy them together if we must. The webhook payload is external: customers parse it, and we cannot redeploy them. Translating at the boundary lets the internal event gain an `Actor` or a `Role` without any of it reaching a customer's endpoint.

Many readers also means a reader can be forgotten. The Starter makes that a failing test: `AuditCoverageTests` scans the assemblies for every type implementing `IAuditableIntegrationEvent` and fails if the audit module has no handler for one.


## When not to bother
All of this is the price of a contract that crosses a process or a deploy boundary. It is not always needed:

- **One process, deployed as one unit, no durable queue.** If messages never outlive a deploy, there is no old message to read, and renaming a field is a refactoring like any other.
- **A domain event that never leaves the process.** It is an implementation detail of the aggregate; give it whatever shape is convenient.
- **A single consumer you own, in the same repository.** A thin event and a call back may be simpler than designing a snapshot, as long as the id still resolves when the consumer runs.

The separate wire shape and mapper are worth it between hosts that are built and deployed separately. Most of the Starter's events, the ones the API publishes for its own modules, travel as they are, without a DTO.


## Conclusion
An integration event ages well when it is named as a past-tense fact, carries what the consumer cannot look up later and nothing secret, says who made the change and when, and only grows: fields at the end with a safe default, a new type for a new meaning, and a namespace that never moves. Consumers do their part by accepting the same message twice and an older one late.

None of these rules is hard. They are only hard to apply after the fact, when the first messages are already in the queue.


## References
- [Wolverine: Message type name](https://wolverinefx.net/guide/messages.html) — how Wolverine identifies a message type on the wire.
- [Wolverine: Transactional outbox](https://wolverinefx.net/guide/durability/) — durable inbox and outbox, and at-least-once delivery.
- [RabbitMQ: Reliability guide](https://www.rabbitmq.com/docs/reliability) — acknowledgements, redelivery and ordering guarantees.
- [What do you mean by "Event-Driven"?](https://martinfowler.com/articles/201701-event-driven.html) — Martin Fowler on event notification and event-carried state transfer.
- [Records (C# reference)](https://learn.microsoft.com/dotnet/csharp/language-reference/builtin-types/record) — positional records and optional parameters.
- [Blouppy Starter](https://starter.blouppy.com/) — the code base the examples come from.
