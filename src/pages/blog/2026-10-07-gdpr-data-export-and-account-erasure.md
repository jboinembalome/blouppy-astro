---
templateKey: 'blog-post'
title: 'GDPR data export and account erasure in an ASP.NET Core SaaS'
date: 2026-10-07T09:00:00.000Z
author: Jimmy Boinembalome
authorimage: /img/jimmy.jpg
category: C#
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

"Export my data" and "Delete my account" look like two buttons. In a modular code base they are two of the hardest features to place: the export has to read every domain at once, and the erasure has to rewrite every domain at once. And most of what an account leaves behind is not only theirs: a workspace somebody created is a fact about an organization as much as a fact about a person, and their colleagues still need to work in it.

In this article, we will build both, the access and portability rights (GDPR articles 15 and 20) and the erasure right (article 17), in an ASP.NET Core application with EF Core and PostgreSQL, while keeping each domain's boundaries intact.

> **_Note:_**  This article describes what the code does. It is engineering, not legal advice: whether it is enough for your product and your jurisdiction is for you and your counsel to decide.


## A module, not a domain
In the code base this comes from, a domain may not read a peer's data. Organizations, Workspaces, Notifications and the identity host all hold something about the person, so neither feature can live inside one of them.

So both features live in a **module**, `Blouppy.Privacy`, which owns **two ports** of its own, declared in `Blouppy.Infrastructure.Database.Abstractions/Privacy/`:

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

Both are implemented once, over the shared `BlouppyDbContext`. A query whose entire purpose is to cross every boundary at once has no honest home inside a domain: it belongs to the thing that needs it, declared as its own contract. 😉


## The export: a snapshot, a generator, a stream
`UserDataRepository` reads everything belonging to the person and nothing belonging to anybody else. Every clause narrows to rows they created, own, belong to or received: an export must not hand somebody a copy of their colleagues' work.

A few rows live in tables the application never maps, such as the identity host's `asp_net_user_logins` in the same database: those are read in place with `Database.SqlQuery<T>`.

What is left out matters as much: the password hash, the two-factor secret, the recovery codes, a token value or a provider's key are never exported. They exist only to sign the person in, and a copy of them would be a way into the account.

The snapshot then goes through `UserDataArchiveGenerator`, an `IFileGenerator<UserDataSnapshot>`:

```csharp
var entries = new List<ArchiveEntry>
{
    Text("README.txt", BuildReadme(request)),
    Json("profile.json", request.Profile)
};

entries.AddRange(
[
    Json("organizations.json", request.Organizations),
    Csv("organizations.csv", () => organizationsCsvExporter.ExportToCsvAsync(request.Organizations, cancellationToken)),
    Json("workspaces.json", request.Workspaces),
    Csv("workspaces.csv", () => workspacesCsvExporter.ExportToCsvAsync(request.Workspaces, cancellationToken)),
    // ... one JSON and one CSV per collection
]);

await archiveBuilder.BuildAsync(entries, destination, cancellationToken);
```

- Each collection is written **twice**. Article 20 asks for a "structured, commonly used and machine-readable format": the two readings of that phrase are a spreadsheet and a parser, and shipping both costs a few kilobytes.
- `ICsvExporter<T>` writes one CSV per record type (over CsvHelper).
- `IArchiveBuilder` streams the ZIP: each `ArchiveEntry` opens its content lazily, one at a time, so a big account costs one entry of memory.
- The generator writes into a `Stream` it is handed, and never decides where it goes.

The export reads every table an account touches, so it is built in the background. `POST /data-exports` records a `DataExport` row and publishes a `DataExportRequestedIntegrationEvent` through the outbox. The consumer then calls `DataExportService.BuildAsync`:

```csharp
await using var scratch = TemporaryFileStream.Create();

await archiveGenerator.WriteAsync(snapshot.Value, scratch, cancellationToken);

scratch.Position = 0;

var stored = await fileStorage.SaveAsync(
    new FileToStore(
        Folder: $"{PrivacyRules.ExportStorageFolder}/{userId.Value}",
        FileName: metadata.FileName,
        Content: scratch),
    cancellationToken);
```

The service marks the row ready, commits, and **only then** e-mails the link: an e-mail announcing a link is a promise the database has to be able to keep. The link is owner-only and valid for `PrivacyRules.ExportValidity` (7 days), after which `DataExportPurgeJob` deletes the bytes: a copy of somebody's entire account should not sit in storage indefinitely.


## The erasure: one policy per table
Deleting the identity is not enough: it appears as a `created_by` on every organization, workspace and team the person created, as an `owner_id`, as membership rows, as the recipient of notifications. So the design note behind this code holds a **table with one policy per entity**, and the reason for each. Here is a short extract:

| What the account left behind | Policy | Why |
| --- | --- | --- |
| Settings, notification preferences, notifications addressed to them, data exports | **Delete** | Theirs and nobody else's. |
| Organization and team memberships | **Delete** | A live relationship, not a historical fact. |
| `created_by` / `last_modified_by` on organizations, workspaces, teams | **Anonymize** | Audit trail, not content. |
| Pending invitations they sent | **Delete** | Nobody can be asked about them any more. |
| Workspaces they own in somebody else's organization | **Transfer** to that organization's owner | Ownership is a responsibility. |
| An organization they solely own | **Transfer, or delete** | See below. |
| The deletion request row | **Keep** | The record that an erasure was carried out. |

### The deleted user
`CreatedBy` is non-nullable, so an author cannot be blanked out, and blanking it would break every join that resolves one anyway. Contributions are reassigned to a **synthetic user** instead:

```csharp
public static UserId Deleted { get; } = new("deleted-user");
```

The `users_view` projection carries a row for it, by `UNION ALL` after the identity host's `asp_net_users`:

```text
UNION ALL
SELECT
    'deleted-user'  AS id,
    'Deleted user'  AS user_name,
    ''              AS email,
    NULL            AS avatar_url
```

A workspace created by an erased account still renders, as **"Deleted user"**. It exists in no identity table, so nothing can sign in as it. And it is there to be *resolved*, never to be *offered*: every query that lists somebody to act on (a people picker, a member search, an invitation) applies `UserQueryExtensions.ExcludeSyntheticUsers()`, so nobody can invite the deleted user or put it on a team.


## One transaction, bulk statements
The tempting design is an `AccountErasureConfirmed` event that each domain handles. It was rejected: it would leave an account half-erased for as long as the slowest consumer takes, and a failure halfway would leave it that way for good. Erasure rewrites audit columns, drops memberships and reassigns ownership; it touches no aggregate invariant, so nothing is bypassed by doing it in one sweep.

Here is the trimmed `UserErasureRepository.EraseAsync`:

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

Each step is a bulk `ExecuteUpdateAsync` or `ExecuteDeleteAsync`, for example:

```csharp
await dbContext.Workspaces
    .Where(x => x.CreatedBy == userId)
    .ExecuteUpdateAsync(setters => setters.SetProperty(x => x.CreatedBy, deleted), cancellationToken);
```

A long-lived account can touch tens of thousands of rows: materializing each to change one string would turn a second into a minute.


## The sole owner
What happens to an organization the person is the only owner of? Two simple answers were rejected:
- **Block the erasure until they transfer it themselves**: it makes a legal right blockable indefinitely by the person's own inaction.
- **Always delete it**: it destroys other people's work.

`OrganizationSuccessionPlanner` picks the **highest-ranking remaining member**, Admins before Members before Viewers, and within a rank the lowest user id (stable and arbitrary, since a membership row records no seniority). A successor who is not an Admin is promoted to one. An organization with no other member at all is deleted, and its foreign keys cascade through members, workspaces, teams and the rest.

The same planner runs twice: read-only for the privacy page, which names each organization and its fate before the person confirms, and inside the transaction, which recomputes in case the membership changed in between. A preview must never disagree with what it previews. 👍


## A confirmation link, and thirty days
Nothing is erased on the first click. `POST /deletion-request` records an `AccountDeletionRequest` and e-mails a token, of which only the SHA-256 hash is stored:

```csharp
public static readonly TimeSpan GracePeriod = TimeSpan.FromDays(30);

public AccountDeletionRequest(UserId userId, AccountDeletionToken token)
{
    Id = AccountDeletionRequestId.Create();
    UserId = Exceptions.ThrowIfNullOrWhiteSpace(userId);
    TokenHash = Exceptions.ThrowIfNullOrWhiteSpace(token.GetHash());
    Status = AccountDeletionRequestStatus.PendingConfirmation;
    RequestedAt = DateTimeOffsetProvider.UtcNow;
    ExpiresAt = RequestedAt.Add(GracePeriod);
}
```

**Confirming is what erases, not the clock.** The thirty days are the window in which the request stays confirmable and cancellable; then it lapses on its own. Erasure is irreversible: it should follow a decision somebody made, not a timer nobody was watching. Every route also requires the browser session: no personal access token, whatever its scope, can export the data or delete the account.


## What the transaction cannot reach
Two stores sit outside `BlouppyDbContext`: the identity host, in its own process, and Billing, behind its own `DbContext` and schema. They hear of the erasure through events published by the `beforeCommit` callback, `AccountDeletionService.AnnounceAsync`, so they land in the erasure's own outbox:

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

They leave once the erasure commits, never if it rolls back:
- Billing rewrites its subscriptions' audit columns on `AccountErasedIntegrationEvent`, and cancels a deleted organization's subscription at the payment provider on `OrganizationDeletedIntegrationEvent`.
- The identity host revokes the OpenIddict authorizations and tokens, erases the personal access tokens, removes the avatar, then deletes the user.

**The identity goes last.** Deleted first, it would leave anonymization pointing at nobody, and the person unable to sign in and cancel if anything downstream failed. Every handler is idempotent, since a message can be redelivered.

Files follow the same logic in reverse. The sweep returns the export archives' keys in `AccountErasureResult.OrphanedFiles`, and the service deletes the bytes **after** the commit: a file left behind can be swept later, a file deleted before a rollback cannot be brought back.

On the Angular side, `ClientDataPurgeService` wipes the user's `localStorage` keys once the erasure is confirmed, and deliberately keeps the device's own (the language, the theme): a browser is often shared.


## Keeping it complete as the code grows
The sweep only knows the tables it names, so the rule is written down: **a table you add that names a `UserId` gets a line in `UserDataRepository`, a line in `UserErasureRepository`, a row in the policy table, and a test in `UserErasureRepositoryTests`**. A module with its own `DbContext` handles `AccountErasedIntegrationEvent` instead, as Billing does.

Those tests run on a real PostgreSQL. Here is the one that holds the transaction's promise down:

```csharp
var act = () => _sut.EraseAsync(
    user.Id,
    (_, _) =>
    {
        ActDbContext.AccountDeletionRequests.Add(announced);

        throw new InvalidOperationException("The announcement failed.");
    },
    TestContext.Current.CancellationToken);

await act.Should().ThrowAsync<InvalidOperationException>();

(await AssertDbContext.OrganizationMembers.AnyAsync(x => x.OrganizationId == organization.Id && x.MemberId == user.Id, TestContext.Current.CancellationToken))
    .Should()
    .BeTrue();
```


## Conclusion
The export and the erasure both cross every domain, so neither belongs to one. Giving them a module with its own two ports keeps the boundaries honest, and an `IFileGenerator` writing into a stream keeps the export cheap and reusable.

The erasure is a policy before it is code: one decision per table, delete, anonymize or transfer, with a synthetic "Deleted user" so that other people's history still renders. Applied in one transaction, confirmed by an e-mailed link, announced through the outbox to the stores it cannot reach, with the identity last.

This is how the GDPR export and erasure are built in [Blouppy Starter](https://starter.blouppy.com/), and its [privacy module page](https://docs.starter.blouppy.com/modules/privacy/) has the full picture.

*Thanks for reading! 🙂*
