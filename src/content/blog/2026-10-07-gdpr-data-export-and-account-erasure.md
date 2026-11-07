---
templateKey: 'blog-post'
title: 'GDPR data export and account erasure in an ASP.NET Core SaaS'
date: 2026-10-07T09:00:00.000Z
updated: 2026-11-07T09:00:00.000Z
author: Jimmy Boinembalome
authorimage: /img/jimmy.jpg
category: C#
topic: 'Security'
illustration: 2
categorycolor: bg-purple-100 text-purple-800
featuredpost: true
featuredimage: /img/gdpr-data-export-and-account-erasure.jpg
description: >-
  Learn how to implement a GDPR data export and a real account erasure in a modular ASP.NET Core application, without breaking domain boundaries or other people's history.
tags:
  - Development
  - C#
  - ASP.NET Core
  - EF Core
  - PostgreSQL
  - GDPR
---

"Export my data" and "Delete my account" look like two buttons. In a modular code base, they are hard to place: the export reads every domain at once, and the erasure rewrites every domain at once. And much of what an account leaves behind is not only theirs: their colleagues still work in the workspaces they created.

In this article, we will build both, the rights of access and portability ([GDPR articles 15](https://eur-lex.europa.eu/eli/reg/2016/679/oj#art_15) and [20](https://eur-lex.europa.eu/eli/reg/2016/679/oj#art_20)) and the right to erasure ([article 17](https://eur-lex.europa.eu/eli/reg/2016/679/oj#art_17)), in an ASP.NET Core application with EF Core and PostgreSQL, without breaking the domains' boundaries.

> **_Note:_**  This article describes what the code does. It is engineering, not legal advice: whether it is enough for your product and jurisdiction is for you and your counsel to decide.


## A module, not a domain
A domain may not read a peer's data, and Organizations, Workspaces, Notifications and the identity host all hold something about the person. So both features live in a **module**, `Blouppy.Privacy`, which owns **two ports**, declared in `Blouppy.Infrastructure.Database.Abstractions/Privacy/` (trimmed):

```csharp
public interface IUserDataRepository
{
    Task<SearchResult<UserDataSnapshot>> TryGetSnapshotAsync(UserId userId, CancellationToken cancellationToken = default);
}

public interface IUserErasureRepository
{
    Task<AccountErasureResult> EraseAsync(
        UserId userId,
        Func<AccountErasureResult, CancellationToken, Task> beforeCommit,
        CancellationToken cancellationToken = default);
}
```

Both are implemented once, over the shared `BlouppyDbContext`: a query whose purpose is to cross every boundary belongs to the feature that needs it, not to a domain.


## The export: a snapshot, a generator, a stream
`UserDataRepository` reads everything that belongs to the person and nothing that belongs to anyone else: rows they created, own, belong to or received. Tables the application never maps, such as the identity host's `asp_net_user_logins`, are read with [`Database.SqlQuery<T>`](https://learn.microsoft.com/ef/core/querying/sql-queries). The password hash, the two-factor secret, recovery codes, token values and provider keys are never exported: a copy of them would be a way into the account.

The snapshot then goes through `UserDataArchiveGenerator`, an `IFileGenerator<UserDataSnapshot>` that writes a ZIP into the stream it is handed:

- Each collection is written **twice**, as `organizations.json` and `organizations.csv` for example. Article 20 asks for a "structured, commonly used and machine-readable format": a spreadsheet and a parser are the two readings of that phrase.
- `ICsvExporter<T>` writes one CSV per record type, over [CsvHelper](https://joshclose.github.io/CsvHelper/).
- `IArchiveBuilder` streams the ZIP: each `ArchiveEntry` opens its content lazily, so a large account costs one entry of memory.

The export reads every table an account touches, so it is built in the background. `POST /data-exports` records a `DataExport` row and publishes a `DataExportRequestedIntegrationEvent` through the outbox. The consumer writes the archive into a temporary file stream, saves it through `IFileStorage`, marks the row ready, commits, and **only then** e-mails the link: the database must be able to keep the promise the e-mail makes. The link is owner-only and valid for `PrivacyRules.ExportValidity` (7 days); then `DataExportPurgeJob` deletes the bytes.


## The erasure: one policy per table
Deleting the identity is not enough: the person appears as `created_by`, as an `owner_id`, in membership rows and as the recipient of notifications. So the design note behind this code holds **one policy per entity**, with its reason. An extract:

| What the account left behind | Policy | Why |
| --- | --- | --- |
| Settings, notification preferences, notifications addressed to them, data exports | **Delete** | Theirs and nobody else's. |
| Organization and team memberships | **Delete** | A live relationship, not a historical fact. |
| `created_by` / `last_modified_by` on organizations, workspaces, teams | **Anonymize** | Audit trail, not content. |
| Pending invitations they sent | **Delete** | Nobody can be asked about them any more. |
| Workspaces they own in someone else's organization | **Transfer** to that organization's owner | Ownership is a responsibility. |
| An organization they solely own | **Transfer, or delete** | See below. |
| The deletion request row | **Keep** | The record that an erasure was carried out. |

### The deleted user
`CreatedBy` is non-nullable, and blanking it would break every join that resolves an author. Contributions are reassigned to a **synthetic user** instead, `UserId.Deleted` (`new("deleted-user")`). The `users_view` projection adds a row for it with `UNION ALL` after the identity host's `asp_net_users`:

```sql
UNION ALL
SELECT
    'deleted-user'          AS id,
    'Deleted user'          AS user_name,
    ''                      AS email,
    NULL                    AS avatar_url
```

A workspace created by an erased account still renders, authored by **"Deleted user"**, who exists in no identity table and cannot sign in. It is there to be *resolved*, never *offered*: every query that lists people to act on applies `UserQueryExtensions.ExcludeSyntheticUsers()`.


## One transaction, bulk statements
An `AccountErasureConfirmed` event handled by each domain was rejected: the account would stay half-erased as long as the slowest consumer takes, and for good after a failure halfway. Erasure touches no aggregate invariant, so nothing is bypassed by doing it in one sweep.

Here is `UserErasureRepository.EraseAsync`, trimmed:

```csharp
var strategy = dbContext.Database.CreateExecutionStrategy();

return await strategy.ExecuteAsync(async () =>
{
    await using var transaction = await dbContext.Database.BeginTransactionAsync(cancellationToken);

    // The deletion request marked confirmed shares the erasure's fate.
    await dbContext.SaveChangesAsync(cancellationToken);

    var plan = await OrganizationSuccessionPlanner.PlanAsync(dbContext, userId, cancellationToken);
    var orphanedFiles = await CollectExportArchivesAsync(userId, cancellationToken);

    // Read before the memberships go: who left which organization, who inherited which.
    var departures = await ReadDeparturesAsync(userId, plan, cancellationToken);
    var transfers = await ReadTransfersAsync(plan, cancellationToken);
    // ... deletedOrganizations taken from the plan

    await ApplySuccessionAsync(userId, plan, cancellationToken);
    await DropMembershipsAsync(userId, cancellationToken);
    await TransferRemainingOwnershipAsync(userId, cancellationToken);
    await AnonymizeAuditEntriesAsync(userId, cancellationToken);
    await SettleInvitationsAsync(userId, cancellationToken);
    await AnonymizeContributionsAsync(userId, cancellationToken);
    await DeletePersonalRowsAsync(userId, cancellationToken);

    var result = new AccountErasureResult(plan, orphanedFiles, departures, transfers, deletedOrganizations);

    await beforeCommit(result, cancellationToken);

    await dbContext.SaveChangesAsync(cancellationToken);
    await transaction.CommitAsync(cancellationToken);

    return result;
});
```

The [execution strategy](https://learn.microsoft.com/ef/core/miscellaneous/connection-resiliency) wraps the whole transaction, so a transient failure retries all of it. Each step is a bulk [`ExecuteUpdateAsync` or `ExecuteDeleteAsync`](https://learn.microsoft.com/ef/core/saving/execute-insert-update-delete), such as `Workspaces.Where(x => x.CreatedBy == userId).ExecuteUpdateAsync(...)`: a long-lived account can touch tens of thousands of rows, and loading each to change one string would turn a second into a minute.


## The sole owner
What happens to an organization the person solely owns? Blocking the erasure until they transfer it would make a legal right blockable by their own inaction; always deleting it would destroy other people's work.

`OrganizationSuccessionPlanner` picks the **highest-ranking remaining member**, Admins before Members before Viewers, and within a rank the lowest user id (stable and arbitrary, since a membership row records no seniority). A successor who is not an Admin is promoted. An organization with no other member is deleted, and its foreign keys cascade through members, workspaces, teams and the rest.

The same planner runs read-only for the privacy page, which shows each organization's fate before the person confirms, and again inside the transaction, in case the membership changed in between.


## A confirmation link, and thirty days
Nothing is erased on the first click. `POST /deletion-request` records an `AccountDeletionRequest` and e-mails a token, of which only the SHA-256 hash is stored; the request expires after `GracePeriod`, 30 days.

**Confirming is what erases, not the clock.** The thirty days are the window to confirm or cancel; then the request lapses. An irreversible erasure should follow a decision, not a timer nobody was watching. Every route also requires the browser session: no personal access token can export the data or delete the account.


## What the transaction cannot reach
Two stores sit outside `BlouppyDbContext`: the identity host, in its own process, and Billing, with its own `DbContext` and schema. They learn about the erasure through events published by the `beforeCommit` callback, `AccountDeletionService.AnnounceAsync`, so the events land in the erasure's own outbox:

```csharp
foreach (var organizationId in erasure.DeletedOrganizations)
{
    await organizationDeletedPublisher.PublishAsync(
        new OrganizationDeletedIntegrationEvent(organizationId),
        cancellationToken);
}

await accountErasedPublisher.PublishAsync(
    new AccountErasedIntegrationEvent(userId),
    cancellationToken);
```

They leave only if the erasure commits:
- Billing rewrites its subscriptions' audit columns on `AccountErasedIntegrationEvent`, and cancels a deleted organization's subscription at the payment provider on `OrganizationDeletedIntegrationEvent`.
- The identity host revokes the OpenIddict authorizations and tokens, erases the personal access tokens, removes the avatar, then deletes the user.

**The identity goes last**, so that the person can still sign in if anything downstream fails. Every handler is idempotent, since a message can be redelivered.

Files follow the opposite order. The sweep returns the export archives' keys in `AccountErasureResult.OrphanedFiles`, and the service deletes the bytes **after** the commit: a file left behind can be swept later, but a file deleted before a rollback cannot be restored. In Angular, `ClientDataPurgeService` then wipes the user's `localStorage` keys and keeps the device's own (language, theme): a browser is often shared.


## Keeping it complete as the code grows
The sweep only knows the tables it names, so the rule is written down: **a table you add that names a `UserId` gets a line in `UserDataRepository`, a line in `UserErasureRepository`, a row in the policy table and a test in `UserErasureRepositoryTests`**. A module with its own `DbContext` handles `AccountErasedIntegrationEvent` instead, as Billing does.

Those tests run on a real PostgreSQL. One of them makes the `beforeCommit` callback throw, then asserts that the person's membership is still there and that the row added in the callback was never written: a fact announced about an erasure that did not happen would be a lie.


## Conclusion
The export and the erasure both cross every domain, so they live in a module with its own two ports, and the export streams into an archive. The erasure is a policy before it is code: one decision per table, a synthetic "Deleted user" so that other people's history still renders, one transaction, a confirmation link, and the outbox to reach the other stores, the identity last.

This is how the GDPR export and erasure work in [Blouppy Starter](https://starter.blouppy.com/); its [privacy module page](https://docs.starter.blouppy.com/modules/privacy/) has the full picture.

## References
- [Regulation (EU) 2016/679, the GDPR (EUR-Lex)](https://eur-lex.europa.eu/eli/reg/2016/679/oj) — articles 15 (access), 17 (erasure) and 20 (portability).
- [Guidelines 01/2022 on the right of access (EDPB)](https://www.edpb.europa.eu/documents/guideline/guidelines-012022-on-data-subject-rights-right-of-access_en) — what a data export is expected to contain.
- [ExecuteUpdate and ExecuteDelete (Microsoft Learn)](https://learn.microsoft.com/ef/core/saving/execute-insert-update-delete) — bulk updates and deletes in EF Core.
- [Connection resiliency (Microsoft Learn)](https://learn.microsoft.com/ef/core/miscellaneous/connection-resiliency) — execution strategies and user-initiated transactions.
- [SQL queries (Microsoft Learn)](https://learn.microsoft.com/ef/core/querying/sql-queries) — `Database.SqlQuery<T>` for unmapped tables.
- [CsvHelper](https://joshclose.github.io/CsvHelper/) — the CSV library behind `ICsvExporter<T>`.
- [Blouppy Starter documentation: privacy](https://docs.starter.blouppy.com/modules/privacy/) — the module, its policies and its configuration.
