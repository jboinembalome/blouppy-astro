---
templateKey: 'blog-post'
title: 'An audit log that can''t lie: building one in ASP.NET Core with the outbox'
date: 2026-12-29T09:00:00.000Z
author: Jimmy Boinembalome
authorimage: /img/jimmy.jpg
category: C#
categorycolor: bg-purple-100 text-purple-800
featuredpost: true
featuredimage: /img/an-audit-log-that-cant-lie.jpg
description: >-
  Learn how to build an audit log in ASP.NET Core that records a change if and only if it committed, and an architecture test that keeps it complete as the product grows.
tags:
  - Development
  - C#
  - ASP.NET Core
  - EF Core
  - Architecture
  - Testing
---

Sooner or later, a B2B customer asks the question: *who changed this member's role, when, and from where?* So we add an audit log. And the first version usually lies in one of three ways: it records a change that was rolled back, it misses a change that was committed, or it simply never hears about the feature someone shipped last month.

The first two are a transaction problem. The third one is a process problem, and no code review catches it reliably.

In this article, we will build an audit log that is written from integration events through a **transactional outbox**, so an entry exists if and only if the change committed. Then we will add an **architecture test** that turns a forgotten entry into a red build.


## Why the obvious approaches fail
Before writing any code, let's look at what we will *not* do, and why.

- **An EF Core `SaveChangesInterceptor` that records every changed column.** It records columns, not intents. An administrator wants to read *"Alice changed Bob's role from Member to Admin"*, not *"row 42, column role"*. And it only sees the one `DbContext` it is plugged into: a billing module with its own context stays invisible.
- **Writing the entry in the same transaction, through a port each domain calls.** Every domain would write a model it does not own, and a module with its own `DbContext` could not take part.
- **One generic `AuditEntryRequestedIntegrationEvent`, built by each producer.** Every domain would learn the log's format.
- **The application logs.** Not queryable by the customer, and kept for as long as the operations team decides.

What we want instead: each producer publishes a **fact** (*a member's role changed*), and one audit module is the only place that knows how an entry is shaped.


## The path of an entry
Here is the whole flow:

```text:clipboard=false
request ── service ── aggregate raises XxxDomainEvent
                       │  PublishDomainEventsInterceptor, before SaveChanges
                       ▼
           PublishIntegrationEventWhen…DomainEventHandler   (in the producing domain)
             AuditActor.Of(ICurrentUserService)
                       │  IIntegrationEventPublisher → outbox row, same transaction as the change
                       ▼
           commit ── the bus delivers ── Blouppy.Audit handler ── AuditEntry ── commit
```

The integration event is not sent to the broker right away: it is written as an **outbox row** (here Wolverine's, on PostgreSQL), in the same transaction as the change. If the change rolls back, the outbox row goes with it. If it commits, the message will be delivered, even if the broker is down for a minute.

So the entry is **atomic with the change, but not synchronous with it**: it lands a moment later.


## Step 1: the aggregate says what happened
Let's start in the domain. A role change is an `Update` on `OrganizationMember`, and it raises a domain event only when the role actually differs:

```csharp
public void Update(
    OrganizationRole role)
{
    if (Role == role)
    {
        return;
    }

    var previousRole = Role;

    Role = role;

    AddDomainEvent(new OrganizationMemberRoleChangedDomainEvent(OrganizationId, MemberId, previousRole, role));
}
```

Saving a form without changing anything records nothing, and that rule lives in the aggregate.

The domain events are dispatched by `PublishDomainEventsInterceptor` in `SavingChangesAsync`, right **before** EF Core commits, so the handlers share the same scoped `DbContext` and transaction. It dispatches what the aggregate chose to raise; it never guesses an intent from columns.


## Step 2: capture the actor where the change is made
The consumer that writes the entry runs off the request, where there is no current user. So the actor must be captured **before** the message leaves. Here is `AuditActor`:

```csharp
public sealed record AuditActor(
    UserId UserId,
    ActorChannel Channel,
    string? IpAddress = null,
    string? UserAgent = null)
{
    public static AuditActor System { get; } = new(UserId.ExternalIntegration, ActorChannel.App);

    public static AuditActor Of(ICurrentUserService currentUserService)
    {
        ArgumentNullException.ThrowIfNull(currentUserService);

        var origin = currentUserService.Origin;

        return new AuditActor(
            currentUserService.UserId,
            currentUserService.Channel,
            origin?.IpAddress,
            origin?.UserAgent);
    }
}
```

- `Channel` says *how*: the browser (`App`), a personal access token (`Api`) or the in-app assistant.
- `IpAddress` and `UserAgent` answer *from where*. `AuditActor.System` covers the payment provider's confirmations, which come from nobody's request.

> **_Note:_**  The IP address comes from `X-Forwarded-For`, trusted only from the gateway, which overwrites whatever the client sent.

Every audited event implements one small contract:

```csharp
public interface IAuditableIntegrationEvent : IIntegrationEvent
{
    AuditActor Actor { get; }

    OrganizationId? OrganizationId { get; }

    DateTimeOffset OccurredAt { get; }
}

public sealed record OrganizationMemberRoleChangedIntegrationEvent(
    OrganizationId OrganizationId,
    UserId MemberId,
    string PreviousRole,
    string Role,
    AuditActor Actor,
    DateTimeOffset OccurredAt) : IAuditableIntegrationEvent;
```

`Actor` is a **required positional parameter**, so no publisher can forget it. And the roles travel as `string`: the audit module may not reference the Organizations models.

Now the producer's domain event handler, in the Organizations domain:

```csharp
internal sealed class PublishIntegrationEventWhenOrganizationMemberRoleChangedDomainEventHandler(
    IIntegrationEventPublisher<OrganizationMemberRoleChangedIntegrationEvent> integrationEventPublisher,
    ICurrentUserService currentUserService)
    : IDomainEventHandler<OrganizationMemberRoleChangedDomainEvent>
{
    public async Task HandleAsync(OrganizationMemberRoleChangedDomainEvent @event, CancellationToken cancellationToken)
        => await integrationEventPublisher.PublishAsync(
            new OrganizationMemberRoleChangedIntegrationEvent(
                @event.OrganizationId,
                @event.MemberId,
                @event.PreviousRole.ToString(),
                @event.Role.ToString(),
                AuditActor.Of(currentUserService),
                @event.DateOccurred.ToUniversalTime()),
            cancellationToken);
}
```

The Organizations domain knows nothing about audit entries. It publishes a fact, which anybody else can reuse.


## Step 3: the audit module writes the entry
On the other side, one handler per event turns the fact into an entry:

```csharp
internal sealed class RecordWhenOrganizationMemberRoleChangedIntegrationEventHandler(
    IAuditEntryRecorder recorder)
    : IIntegrationEventHandler<OrganizationMemberRoleChangedIntegrationEvent>, IRecordsAuditEvents
{
    private const string RoleField = "role";

    public static IReadOnlyCollection<AuditEventType> RecordedEventTypes { get; } = [AuditEventType.MemberRoleChanged];

    public Task HandleAsync(
        OrganizationMemberRoleChangedIntegrationEvent @event,
        CancellationToken cancellationToken = default)
        => recorder.RecordAsync(
            @event,
            AuditEventType.MemberRoleChanged,
            new AuditTarget(AuditTargetType.Member, @event.MemberId.Value),
            [AuditChanges.Changed(RoleField, @event.PreviousRole, @event.Role)],
            cancellationToken);
}
```

The `changes` are an **allow-list in code**: a field not named here is not written. If someone adds a property to the event later (a token for an e-mail, say), it stays out of the log until somebody decides it belongs there. That is how secrets stay out.

`RecordedEventTypes` looks odd for now. Keep it in mind, the coverage test uses it. 😉

The shared part lives in `AuditEntryRecorder`:

```csharp
// The message id is the same on every redelivery: it is what makes recording twice insert nothing.
var messageId = integrationEventContext.MessageId
    ?? throw new InvalidOperationException($"An audit entry is only recorded from a consumed message, and {eventType} came without one.");

if (await auditEntriesRepository.ExistsAsync(messageId, organizationId, cancellationToken))
{
    return;
}

var entry = new AuditEntry(
    organizationId: organizationId,
    occurredAt: @event.OccurredAt,
    eventType: eventType,
    actorId: @event.Actor.UserId,
    channel: @event.Actor.Channel,
    ipAddress: @event.Actor.IpAddress,
    userAgent: @event.Actor.UserAgent,
    targetType: target.Type,
    targetId: target.Id,
    targetLabel: target.Label,
    changes: changes,
    sourceMessageId: messageId);

await auditEntriesRepository.AddAsync(entry, cancellationToken);

await unitOfWork.CommitAsync(cancellationToken);
```

An outbox gives **at-least-once** delivery, so the consumer must be idempotent. The recorder checks the message id first, and a unique index on `(SourceMessageId, OrganizationId)` refuses what two concurrent deliveries might still race to insert.

Also notice `occurredAt`: it is the **event's** time, not the insert's. A late delivery still sorts where it happened.


## The shape of an entry
The constructor above lists every column of the `audit_entries` row. `AuditEntry` has that constructor and no method that changes it: it is append-only by design. A few decisions behind it:
- **A person is never a label.** The actor is an id, resolved to a name at read time. A renamed person reads under their current name, and an erased account reads as *Deleted user*.
- **A target that may disappear keeps a snapshot.** A deleted workspace's name is stored in `TargetLabel`.
- **`Changes` is JSON**, `[{ "field", "from", "to" }]`, stored as `jsonb` in PostgreSQL.


## Nothing forgotten: the coverage test
Now the third lie: the feature nobody wired to the log. Here is the idea. Every write a driving port offers (every method of an `I…Service` in a domain's `.Abstractions` project) must be **declared**, either audited or not audited with a reason:

```csharp
internal static class AuditCoverage
{
    public abstract record Row;

    public sealed record Audited(params AuditEventType[] EventTypes) : Row;

    public sealed record NotAudited(string Reason) : Row;

    public static readonly IReadOnlyDictionary<string, Row> Rows = new Dictionary<string, Row>
    {
        ["IOrganizationMembersService.TryUpdateAsync"] = new Audited(AuditEventType.MemberRoleChanged),
        ["IOrganizationMembersService.TryDeleteAsync"] = new Audited(AuditEventType.MemberRemoved),
        ["IOrganizationsService.TryDeleteAsync"] = new NotAudited("The organization's audit log is deleted with it: there is no log left to record it in"),
        ["IWorkspacesService.TryDeleteAsync"] = new Audited(AuditEventType.WorkspaceDeleted),
        ["IUserSettingsService.TryUpdateAsync"] = new NotAudited(Personal),
        // ...
    };
}
```

Then a test scans the assemblies with reflection and compares:

```csharp
private static readonly string[] ReadPrefixes = ["Get", "TryGet", "Count", "List", "Search", "Find", "Is", "Has", "Can"];

[Fact]
public void Every_write_of_a_driving_port_should_have_a_row()
{
    // Act
    var writes = WriteMethods();

    // Assert
    writes
        .Should()
        .Contain("IOrganizationMembersService.TryUpdateAsync", "the scan is meaningless if it does not find the ports");

    var missing = writes.Except(AuditCoverage.Rows.Keys).ToArray();

    missing
        .Should()
        .BeEmpty($"each write is audited or excluded with a reason in AuditCoverage, and these say neither: {string.Join(", ", missing)}");
}

// A prefix only when a word follows it: CancelAsync is not a Can.
private static bool IsRead(string methodName)
    => ReadPrefixes.Any(prefix =>
        methodName.Length > prefix.Length
        && methodName.StartsWith(prefix, StringComparison.Ordinal)
        && char.IsUpper(methodName[prefix.Length]));
```

Let's look at what this gives us:
- **Anything not named like a read is a write.** A read misnamed costs one `NotAudited` row; a write misnamed would cost a missing entry.
- **The sanity check** (`Contain("IOrganizationMembersService.TryUpdateAsync")`) makes sure the scan finds the ports at all. A test that scans nothing would pass forever.

So when someone adds `IWebhooksService.TryRotateSecretAsync`, the build is red until they decide, in the pull request, whether an administrator would be asked about it. That is what keeps the log complete as the product grows. 👍

The same test class holds the other side of the contract:
- `Every_row_should_name_a_write_that_exists`: a row for a method that was renamed or deleted fails too.
- `Every_auditable_event_should_have_a_handler_in_the_audit_module`: every class implementing `IAuditableIntegrationEvent` must have an `IIntegrationEventHandler<>` in the audit module.
- `Every_audited_row_should_name_a_type_that_a_handler_records` and `Every_event_type_should_be_recorded_by_some_handler`: this is where `RecordedEventTypes` comes in. A row cannot claim an entry nobody writes.
- `Only_the_module_its_repository_and_erasure_should_reach_an_audit_entry`: with NetArchTest, only the audit module, its repository, the `DbContext` and the account erasure may depend on `AuditEntry`. Append-only is held at the boundary.


## Retention and purge
An audit log that grows forever is a liability too. Entries are kept 13 months (`AuditRules.RetentionInMonths`), and the service deletes them in batches:

```csharp
public async Task<int> PurgeExpiredAsync(CancellationToken cancellationToken = default)
{
    var retainedSince = AuditRules.RetainedSince(DateTimeOffsetProvider.UtcNow);

    var purged = 0;
    int deleted;

    do
    {
        deleted = await auditEntriesRepository.DeleteOccurredBeforeAsync(retainedSince, AuditRules.PurgeBatchSize, cancellationToken);

        purged += deleted;
    }
    while (deleted == AuditRules.PurgeBatchSize);

    return purged;
}
```

The repository deletes the 5,000 oldest rows per statement with `ExecuteDeleteAsync`, on an index on `OccurredAt`, until a batch comes back short. No giant `DELETE`.

Once a day, `AuditEntryPurgeJob`, a Quartz.NET `IJob` marked `[DisallowConcurrentExecution]`, calls it. The Quartz store is clustered, so only one replica runs it at a time. And notice that `IAuditLogService.PurgeExpiredAsync` is a write of a driving port: it has its own row in `AuditCoverage`, `NotAudited(Retention)`.


## The export is an entry too
Customers import the log into their own tools, so the CSV export uses stable codes as headers (`occurred_at`, `event_type`, ...) rather than translated labels, and every cell goes through a formula-injection guard (`CsvCells.Neutralize`).

The interesting part is the order in the controller:

```csharp
// Recorded before a byte leaves: an export cut short has still taken the log out.
await auditLogService.RecordExportAsync(AuditLogMapper.MapToExport(filter), cancellationToken);
await unitOfWork.CommitAsync(cancellationToken);

return this.GeneratedFileDownload(
    auditLogFileGenerator,
    AuditLogMapper.MapToFile(fileBaseName, auditLogApiQueryService.StreamAsync(filter, cancellationToken)));
```

The export publishes `AuditLogExportedIntegrationEvent` with the filters that were set, commits, and only then streams the file. Reading the page is not recorded; taking the data away is.


## Conclusion
Publishing facts through a transactional outbox, in the same transaction as the change, means an entry exists if and only if the change committed. Capturing the actor where the change is made, and keying the entry by message id, keeps it correct even when the consumer runs later, or twice.

The third lie is the hardest, because it is about people, not transactions. An architecture test that lists every write and asks for a decision turns *"we forgot to audit it"* into a red build, and a reason written in code for everything that is deliberately left out.

This is how the organization's audit log is built in [Blouppy Starter](https://starter.blouppy.com/), alongside members, billing, webhooks and the AI gateway. The [audit log's documentation](https://docs.starter.blouppy.com/modules/audit-log/) describes what it records and what it leaves out.

*Thanks for reading! 🙂*
