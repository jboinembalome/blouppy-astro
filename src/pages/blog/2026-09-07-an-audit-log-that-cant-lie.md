---
templateKey: 'blog-post'
title: 'An audit log that can''t lie: building one in ASP.NET Core with the outbox'
date: 2026-09-07T09:00:00.000Z
updated: 2026-11-07T09:00:00.000Z
author: Jimmy Boinembalome
authorimage: /img/jimmy.jpg
category: C#
topic: 'Security'
illustration: 1
categorycolor: bg-purple-100 text-purple-800
featuredpost: true
featuredimage: /img/an-audit-log-that-cant-lie.jpg
description: >-
  Learn how to build an ASP.NET Core audit log that records a change if and only if it committed, and an architecture test that keeps it complete as the product grows.
tags:
  - Development
  - C#
  - ASP.NET Core
  - EF Core
  - Architecture
  - Testing
---

Sooner or later, a B2B customer asks: *who changed this member's role, when, and from where?* The first audit log usually lies in one of three ways: it records a change that was rolled back, misses one that was committed, or never hears about the feature shipped last month. The first two are a transaction problem; the third is a process problem no code review reliably catches.

In this article, we will build an audit log written from integration events through a [transactional outbox](https://microservices.io/patterns/data/transactional-outbox.html), so an entry exists if and only if the change committed. Then we will add an **architecture test** that turns a forgotten entry into a red build.


## Why the obvious approaches fail
- **An EF Core [`SaveChangesInterceptor`](https://learn.microsoft.com/ef/core/logging-events-diagnostics/interceptors) that records every changed column.** It records columns, not intents (*"Alice changed Bob's role from Member to Admin"*), and only sees the `DbContext` it is plugged into, so a module with its own context stays invisible.
- **A port each domain calls to write the entry**, or **one generic `AuditEntryRequestedIntegrationEvent`**: every domain would learn the log's model and format.
- **The application logs.** The customer cannot query them, and the operations team decides how long they are kept.

Instead, each producer publishes a **fact** (*a member's role changed*), and only the audit module knows how an entry is shaped.


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

The integration event is written as an **outbox row** ([Wolverine's](https://wolverinefx.net/guide/durability/), on PostgreSQL) in the same transaction as the change: if the change rolls back, the row goes with it; if it commits, the message will be delivered, even if the broker is down for a minute. The entry is **atomic with the change, but not synchronous with it**.


## Step 1: the aggregate says what happened
A role change is an `Update` on `OrganizationMember`, which raises a domain event only when the role actually differs (the body of `Update(OrganizationRole role)`, guard clauses omitted):

```csharp
if (Role == role)
{
    return;
}

var previousRole = Role;

Role = role;

AddDomainEvent(new OrganizationMemberRoleChangedDomainEvent(OrganizationId, MemberId, previousRole, role));
```

Saving a form without changing anything records nothing. `PublishDomainEventsInterceptor` dispatches the domain events in `SavingChangesAsync`, right **before** EF Core commits, so the handlers share the `DbContext` and its transaction; it dispatches what the aggregate raised, never an intent guessed from columns.


## Step 2: capture the actor where the change is made
The consumer that writes the entry runs off the request, where there is no current user, so the actor must be captured **before** the message leaves. Here is `AuditActor` (abridged):

```csharp
public sealed record AuditActor(
    UserId UserId,
    ActorChannel Channel,
    string? IpAddress = null,
    string? UserAgent = null)
{
    // ... AuditActor.System and AuditActor.Erasure, for changes nobody's request makes

    public static AuditActor Of(ICurrentUserService currentUserService)
    {
        // ... argument check

        var origin = currentUserService.Origin;

        return new AuditActor(
            currentUserService.UserId,
            currentUserService.Channel,
            origin?.IpAddress,
            origin?.UserAgent);
    }
}
```

`Channel` says *how*: the browser (`App`), a token (`Api`) or the in-app assistant (`Assistant`); `IpAddress` and `UserAgent` say *from where*.

The IP address comes from `X-Forwarded-For`, which the [forwarded headers middleware](https://learn.microsoft.com/aspnet/core/host-and-deploy/proxy-load-balancer) only believes from the configured proxy networks, so a client cannot claim another address.

Every audited event implements one small contract, `IAuditableIntegrationEvent`, which exposes `Actor`, `OrganizationId` and `OccurredAt`:

```csharp
public sealed record OrganizationMemberRoleChangedIntegrationEvent(
    OrganizationId OrganizationId,
    UserId MemberId,
    string PreviousRole,
    string Role,
    AuditActor Actor,
    DateTimeOffset OccurredAt) : IAuditableIntegrationEvent;
```

`Actor` is a **required positional parameter**, so no publisher can forget it, and the roles travel as `string` because the audit module may not reference the Organizations models.

The producer's `PublishIntegrationEventWhenOrganizationMemberRoleChangedDomainEventHandler`, in the Organizations domain, injects `ICurrentUserService` and publishes the event with `AuditActor.Of(currentUserService)` and `@event.DateOccurred.ToUniversalTime()`. The Organizations domain knows nothing about audit entries.


## Step 3: the audit module writes the entry
On the other side, one handler per event turns the fact into an entry (argument check omitted):

```csharp
internal sealed class RecordWhenOrganizationMemberRoleChangedIntegrationEventHandler(
    IAuditEntryRecorder recorder)
    : IIntegrationEventHandler<OrganizationMemberRoleChangedIntegrationEvent>, IRecordsAuditEvents
{
    private const string RoleField = "role";

    public static IReadOnlyCollection<AuditEventType> RecordedEventTypes { get; } = [AuditEventType.MemberRoleChanged];

    public Task HandleAsync(OrganizationMemberRoleChangedIntegrationEvent @event, CancellationToken cancellationToken = default)
        => recorder.RecordAsync(
            @event,
            AuditEventType.MemberRoleChanged,
            new AuditTarget(AuditTargetType.Member, @event.MemberId.Value),
            [AuditChanges.Changed(RoleField, @event.PreviousRole, @event.Role)],
            cancellationToken);
}
```

The `changes` are an **allow-list in code**: a property added to the event later (a token for an e-mail, say) stays out of the log until somebody names it here, which is how secrets stay out. `RecordedEventTypes` is for the coverage test, further down.

The shared part lives in `AuditEntryRecorder` (abridged):

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
    // ... the actor's id, channel, IP address and user agent; the target's type, id and label; the changes
    sourceMessageId: messageId);

await auditEntriesRepository.AddAsync(entry, cancellationToken);

await unitOfWork.CommitAsync(cancellationToken);
```

An outbox gives **at-least-once** delivery, so the recorder checks the message id first, and a unique index on `(SourceMessageId, OrganizationId)` refuses what two concurrent deliveries might still race to insert (see [idempotent message handlers](https://www.blouppy.com/blog/2026-08-20-idempotent-message-handlers-with-deterministic-ids/)). `occurredAt` is the **event's** time, so a late delivery still sorts where it happened.

`AuditEntry` has no method that changes it: it is append-only by design.
- **A person is never a label.** The actor is an id, resolved to a name at read time: a renamed person reads under their current name, and an erased account reads as *Deleted user*.
- **A target that may disappear keeps a snapshot**, such as a deleted workspace's name, in `TargetLabel`.
- **`Changes` is JSON**, `[{ "field", "from", "to" }]`, stored as [`jsonb`](https://www.npgsql.org/efcore/mapping/json.html) in PostgreSQL.


## Nothing forgotten: the coverage test
The third lie is the feature nobody wired to the log. Every write a driving port offers (every method of an `I…Service` in a domain's `.Abstractions` project) must be **declared**, as audited or as not audited with a reason:

```csharp
internal static class AuditCoverage
{
    public abstract record Row;

    public sealed record Audited(params AuditEventType[] EventTypes) : Row;

    public sealed record NotAudited(string Reason) : Row;

    public static readonly IReadOnlyDictionary<string, Row> Rows = new Dictionary<string, Row>
    {
        ["IOrganizationMembersService.TryUpdateAsync"] = new Audited(AuditEventType.MemberRoleChanged),
        ["IOrganizationsService.TryDeleteAsync"] = new NotAudited("The organization's audit log is deleted with it: there is no log left to record it in"),
        ["IUserSettingsService.TryUpdateAsync"] = new NotAudited(Personal),
        // ...
    };
}
```

A test scans the assemblies with reflection and compares:

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
```

- **Anything not named like a read is a write**: a method is a read only when one of `ReadPrefixes` is followed by an upper-case letter (`CancelAsync` is not a `Can`). A misnamed read costs one `NotAudited` row; a misnamed write would cost a missing entry.
- **The sanity check** (`Contain(...)`) makes sure the scan finds the ports at all: a test that scans nothing would pass forever.

A new `IWebhooksService.TryRotateSecretAsync` keeps the build red until its author decides, in the pull request, whether an administrator would be asked about it. The same test class holds the other side of the contract:
- A row for a renamed or deleted method fails (`Every_row_should_name_a_write_that_exists`).
- Every `IAuditableIntegrationEvent` needs a handler in the audit module, and the handlers' `RecordedEventTypes` must cover every audited row, so a row cannot claim an entry nobody writes.
- With [NetArchTest](https://www.nuget.org/packages/NetArchTest.Rules), only the audit module, its repository, the `DbContext` and the account erasure may depend on `AuditEntry`, which holds append-only at the boundary.


## Retention and purge
Entries are kept 13 months (`AuditRules.RetentionInMonths`). Once a day, a Quartz.NET job marked `[DisallowConcurrentExecution]` calls `IAuditLogService.PurgeExpiredAsync`, which deletes the 5,000 oldest expired rows per statement with [`ExecuteDeleteAsync`](https://learn.microsoft.com/ef/core/saving/execute-insert-update-delete) until a batch comes back short: no giant `DELETE`. Being a write of a driving port, the purge has its own `AuditCoverage` row, `NotAudited(Retention)`.


## The export is an entry too
The CSV export uses stable codes as headers (`occurred_at`, `event_type`, ...), since customers import it into their tools, and every cell goes through a [CSV injection](https://owasp.org/www-community/attacks/CSV_Injection) guard, `CsvCells.Neutralize`. The controller calls `auditLogService.RecordExportAsync(...)` and commits **before** it streams the file, because "an export cut short has still taken the log out": the export publishes `AuditLogExportedIntegrationEvent` with the filters set. Reading the page is not recorded; taking the data away is.


## Conclusion
Publishing facts through a transactional outbox, in the same transaction as the change, means an entry exists if and only if the change committed; capturing the actor at the change and keying the entry by message id keep it correct when the consumer runs later, or twice. An architecture test that lists every write and asks for a decision turns *"we forgot to audit it"* into a red build.

This is how the organization's audit log is built in [Blouppy Starter](https://starter.blouppy.com/). The [audit log's documentation](https://docs.starter.blouppy.com/modules/audit-log/) describes what it records and what it leaves out.


## References
- [Interceptors](https://learn.microsoft.com/ef/core/logging-events-diagnostics/interceptors) — EF Core's `SaveChangesInterceptor`.
- [ExecuteUpdate and ExecuteDelete](https://learn.microsoft.com/ef/core/saving/execute-insert-update-delete) — set-based deletes without loading entities.
- [Configure ASP.NET Core to work with proxy servers and load balancers](https://learn.microsoft.com/aspnet/core/host-and-deploy/proxy-load-balancer) — trusting `X-Forwarded-For` from known proxies only.
- [Wolverine: Durable inbox and outbox messaging](https://wolverinefx.net/guide/durability/) — the outbox the facts are written to.
- [Npgsql: JSON mapping](https://www.npgsql.org/efcore/mapping/json.html) — `jsonb` columns in EF Core.
- [OWASP Logging Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Logging_Cheat_Sheet.html) — what security logs should record, and what they must not.
- [OWASP: CSV Injection](https://owasp.org/www-community/attacks/CSV_Injection) — why exported cells are neutralized.
- [Pattern: Transactional outbox](https://microservices.io/patterns/data/transactional-outbox.html) — the pattern itself.
- [NetArchTest.Rules](https://www.nuget.org/packages/NetArchTest.Rules) — the architecture-test library.
- [Blouppy Starter: Audit log](https://docs.starter.blouppy.com/modules/audit-log/) — the module this article describes.
