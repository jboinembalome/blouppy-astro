---
templateKey: 'blog-post'
title: 'Testing EF Core repositories on a real PostgreSQL with Testcontainers'
date: 2026-07-15T09:00:00.000Z
updated: 2026-11-07T09:00:00.000Z
author: Jimmy Boinembalome
authorimage: /img/jimmy.jpg
category: C#
topic: 'Testing'
illustration: 2
categorycolor: bg-purple-100 text-purple-800
featuredpost: true
featuredimage: /img/testing-ef-core-repositories-with-testcontainers.jpg
description: >-
  Learn how to test EF Core repositories against a real PostgreSQL started by Testcontainers, with the real migrations and one DbContext each to arrange, act and assert.
tags:
  - Development
  - C#
  - EF Core
  - PostgreSQL
  - Testing
  - Testcontainers
---

A repository is mostly a conversation with the database: translated SQL, constraints, collations, sequences, transactions. The EF Core [in-memory provider](https://learn.microsoft.com/ef/core/providers/in-memory/) has none of those, and [Microsoft's own testing guidance](https://learn.microsoft.com/ef/core/testing/choosing-a-testing-strategy) discourages it: a test can be green on it and fail on PostgreSQL, and `ExecuteUpdateAsync` does not even run on it.

A second trap hides even on a real database: a test that adds an entity and reads it back with the **same `DbContext`** passes because the change tracker still holds the entity, whether or not it was ever saved.

In this article, we will build repository tests that start a real PostgreSQL with **Testcontainers**, apply the real migrations, reset the data between tests, and use three `DbContext` instances: arrange, act, assert.


## Prerequisites
- The [.NET 10 SDK](https://dotnet.microsoft.com/download/dotnet/10.0).
- [Docker](https://docs.docker.com/get-started/get-docker/), wherever the tests run, CI included.

The test project references `xunit.v3`, `AutoFixture`, `FluentAssertions`, `Moq`, `Respawn` and `Testcontainers.PostgreSql`.


## One container per test project
Here is the class that owns the container, trimmed:

```csharp
public sealed class Database
{
    private const string DefaultDatabase = "BlouppyIntegrationTestDb";

    private readonly PostgreSqlContainer _dbContainer = new PostgreSqlBuilder(image: "postgres:17.5")
        .WithAutoRemove(true)
        .WithPassword("Strong_password_123!")
        .WithName(DefaultDatabase)
        .Build();

    public async Task StartContainerAsync()
        => await _dbContainer.StartAsync();

    public string GetConnectionString()
        => new NpgsqlConnectionStringBuilder(_dbContainer.GetConnectionString())
        {
            Database = DefaultDatabase
        }.ConnectionString;
}
```

[`PostgreSqlBuilder`](https://dotnet.testcontainers.org/modules/postgres/) pins the image to `postgres:17.5` rather than whatever `latest` is today, and `WithAutoRemove(true)` lets Docker remove the container when it stops.

> **_Note:_**  `WithName` gives the container a fixed name, so two runs on the same machine at the same time collide. Leave it out if your CI runs jobs in parallel on one Docker host; Testcontainers then generates a unique name.

Starting a container takes seconds, so we do it **once for the whole test project** with an xUnit [collection fixture](https://xunit.net/docs/shared-context):

```csharp
[CollectionDefinition("Database collection")]
public class DatabaseCollection : ICollectionFixture<DatabaseFixture>
{
}
```

Every test class tagged `[Collection("Database collection")]` shares the same fixture and container, and those classes no longer run in parallel with each other, as one shared database requires.


## Apply the real migrations
The schema the tests run on must be the one production runs on. `EnsureCreated()` builds a schema from the model and skips everything the migrations do by hand (a data fix, a view, an index added later), so the fixture runs [`MigrateAsync()`](https://learn.microsoft.com/ef/core/managing-schemas/migrations/applying):

```csharp
public sealed class DatabaseFixture : IAsyncLifetime
{
    public async ValueTask InitializeAsync()
    {
        await Database.StartContainerAsync();

        // ... the current-user mock, and a service provider holding the interceptors

        _blouppyDbContextOptions = GetDefaultDbContextOptionsBuilder<BlouppyDbContext>(serviceProvider, Schemas.Blouppy)
            .AddInterceptors(serviceProvider.GetServices<ISaveChangesInterceptor>())
            .Options;

        // Once for the collection: every test builds four contexts, and each Migrate compares the model
        // with the snapshot before finding nothing to apply.
        await using (var identityDbContext = CreateIdentityDbContext())
        {
            await identityDbContext.Database.MigrateAsync();
        }

        await using (var blouppyDbContext = CreateBlouppyDbContext())
        {
            await blouppyDbContext.Database.MigrateAsync();
        }

        await Database.CreateAsync();
    }
}
```

- The identity host's `ApplicationDbContext` is migrated **first**, because the application's `users_view` reads a table its migrations create. It is the order the production migration runner uses.
- The options carry the **real `SaveChangesInterceptor`s** (`CreatedEntityInterceptor`, `ModifiedEntityInterceptor`, `PublishDomainEventsInterceptor`), so the audit columns are filled exactly as in production. `ICurrentUserService` is mocked because they ask who the current user is, and `IDomainEventPublisher` is a stub: we test the repository, not the event handlers.


## Reset the data between tests
With one database for every test, each test must start from empty tables. Recreating the database would mean migrating again, so [Respawn](https://www.nuget.org/packages/Respawn) deletes the rows and keeps the schema:

```csharp
_respawner = await Respawner.CreateAsync(_connection, new RespawnerOptions
{
    TablesToIgnore = ["__EFMigrationsHistory"],
    SchemasToInclude = [Schemas.Public, Schemas.Blouppy],
    DbAdapter = new PostgresDeleteAdapter()
});
```

`__EFMigrationsHistory` is ignored; otherwise the next run would believe no migration was ever applied.

`PostgresDeleteAdapter` is a custom `IDbAdapter`. A reset runs after every test, and a test writes a handful of rows into a few of the ~80 tables. Respawn's PostgreSQL adapter issues a `TRUNCATE`, which costs the same whatever a table holds; the adapter's comment measures about 100 ms a test, more than the test itself. A `DELETE` of an empty table costs nothing, so the reset drops to a few milliseconds:

```csharp
public string BuildDeleteCommandText(GraphBuilder graph, RespawnerOptions options)
{
    if (graph.ToDelete.Count == 0)
    {
        return string.Empty;
    }

    // One statement, so SET LOCAL holds for exactly the transaction that deletes.
    var builder = new StringBuilder()
        .AppendLine("DO $$")
        .AppendLine("BEGIN")
        .AppendLine("    SET LOCAL session_replication_role = replica;");

    foreach (var table in graph.ToDelete)
    {
        builder.AppendLine($"    DELETE FROM {table.GetFullName('"')};");
    }

    return builder.AppendLine("END").AppendLine("$$;").ToString();
}
```

[`session_replication_role = replica`](https://www.postgresql.org/docs/current/runtime-config-client.html) switches the foreign-key triggers off for the reset, so neither the table order nor a cycle between tables matters. It needs a superuser, which is what a Testcontainers database runs as.


## Three DbContexts: arrange, act, assert
Here is the base class every repository test inherits from, trimmed:

```csharp
[Collection("Database collection")]
public abstract class DatabaseTestsBase : IAsyncDisposable
{
    protected DatabaseTestsBase(DatabaseFixture databaseFixture)
    {
        _databaseFixture = databaseFixture;
        _arrangeIdentityDbContext = databaseFixture.CreateIdentityDbContext();

        Builder = new DatabaseEntityFixture();

        ArrangeDbContext = databaseFixture.CreateBlouppyDbContext();
        ActDbContext = databaseFixture.CreateBlouppyDbContext();
        AssertDbContext = databaseFixture.CreateBlouppyDbContext();

        DataSeed = new DataSeed(Builder, arrangeDbContext: ArrangeDbContext, arrangeIdentityDbContext: _arrangeIdentityDbContext);
    }

    public virtual async ValueTask DisposeAsync()
    {
        await _arrangeIdentityDbContext.DisposeAsync();

        await ArrangeDbContext.DisposeAsync();
        await ActDbContext.DisposeAsync();
        await AssertDbContext.DisposeAsync();

        await _databaseFixture.Database.ResetAsync();
    }
}
```

- `ArrangeDbContext` writes the rows the test needs; whatever it tracks stays in its own change tracker.
- `ActDbContext` is the one the repository under test receives. It starts empty, as in a real request.
- `AssertDbContext` has never seen any entity, so every query it runs **goes to PostgreSQL**. If the repository forgot a column, a mapping or a `SaveChanges`, the assertion sees it.

With a single context, `FirstAsync(x => x.Id == workspace.Id)` would often return the very instance we added, from the [identity map](https://learn.microsoft.com/ef/core/change-tracking/identity-resolution): the test would compare an object with itself.


## Seed the data with Given_a_*() helpers
Each test builds the rows it asserts against rather than relying on sample data. The helpers (`Given_an_Organization()`, `Given_a_Workspace(ownerId, organizationId)`, …) are grouped by entity in a `DataSeed` and write through the arrange context. The rows come from `DatabaseEntityFixture`, an [AutoFixture](https://autofixture.github.io/) `Fixture` with two customizations that matter on a real database:

- `MicrosecondDateTimeOffsetCustomization` truncates every generated `DateTimeOffset` to the microsecond. .NET counts in 100-nanosecond ticks and [PostgreSQL stores microseconds](https://www.postgresql.org/docs/current/datatype-datetime.html), so a random date would come back a few ticks different and fail an equivalency check. The in-memory provider would never show us that.
- `PropertyNameOmitterSpecimenBuilder` leaves `Id` and the audit columns alone: the HiLo sequence assigns the id and the interceptors fill the audit columns, as in production.


## Exclude the domain events once, with [ModuleInitializer]
The aggregates inherit `HasDomainEventsBase` and raise domain events. In these tests a save dispatches nothing, so an entity read back has none of the events its expected copy raised, and `BeEquivalentTo` would fail on every aggregate. One global FluentAssertions option fixes it, in `DatabaseEntityFixture`:

```csharp
[ModuleInitializer]
internal static void ExcludeDomainEvents()
    => AssertionOptions.AssertEquivalencyUsing(options => options
        .Excluding(x => x.Path == nameof(HasDomainEventsBase.DomainEvents)));
```

A [`[ModuleInitializer]`](https://learn.microsoft.com/dotnet/api/system.runtime.compilerservices.moduleinitializerattribute) runs when the assembly loads, before any test. A static constructor is the tempting alternative, but it only runs when its class is first touched, and a test class that never creates a `DatabaseEntityFixture` may run before it.


## A repository test
Here is `WorkspacesRepositoryTests`, put together:

```csharp
public sealed class WorkspacesRepositoryTests : DatabaseTestsBase
{
    private readonly WorkspacesRepository _sut;

    public WorkspacesRepositoryTests(DatabaseFixture databaseFixture)
        : base(databaseFixture)
    {
        _sut = new WorkspacesRepository(ActDbContext);
    }

    [Fact]
    public async Task Should_add_Workspace()
    {
        // Arrange
        var organization = await DataSeed.Organizations.Given_an_Organization();

        var workspace = Builder.Create<Workspace>();
        workspace.SetProperty(x => x.OrganizationId, organization.Id);

        // Act
        await _sut.AddAsync(workspace, TestContext.Current.CancellationToken);
        await ActDbContext.SaveChangesAsync(TestContext.Current.CancellationToken);

        // Assert
        var createdWorkspace = await AssertDbContext.Workspaces
            .FirstAsync(x => x.Id == workspace.Id, cancellationToken: TestContext.Current.CancellationToken);

        createdWorkspace
            .Should()
            .BeEquivalentTo(workspace);
    }
}
```

The organization comes from `Given_an_Organization()`: the foreign key is real, so a workspace needs one.

The tests that need a real database most are those that bypass the change tracker. `TransferOwnershipAsync` is a single [`ExecuteUpdateAsync`](https://learn.microsoft.com/ef/core/saving/execute-insert-update-delete), which the in-memory provider cannot run. Its test seeds three workspaces: the one that must move, one owned by someone else, and one owned by the same person in another organization. It then reads all three owners back through `AssertDbContext`; the two that must not change are what test the `Where` clause.

Constraints are tested the same way: a webhook pointing at an organization that does not exist must make `SaveChangesAsync` throw a `DbUpdateException`. On the in-memory provider, that save succeeds.


## Run one class while iterating
The test projects run on [Microsoft.Testing.Platform](https://learn.microsoft.com/dotnet/core/testing/microsoft-testing-platform-intro), selected in `back/global.json`, so from `back/` `dotnet test` takes a `--project` and a `--filter-class`:

```bash
cd back
dotnet test --project Blouppy.Infrastructure.Database.IntegrationTests/Blouppy.Infrastructure.Database.IntegrationTests.csproj \
  --filter-class "*WorkspacesRepositoryTests"
```


## What it costs
Docker is required wherever the tests run, the tests are slower than an in-memory fake, and each test writes its own data. Services, validators and handlers stay unit tested with mocked ports; only the adapters touch a container.


## Conclusion
The in-memory provider tests a database that does not exist. A real PostgreSQL started by Testcontainers, the real migrations applied once and the rows reset with Respawn give tests that fail for the reasons production would, and an assert context that has never tracked anything reads what PostgreSQL really stored.

This is how the database adapter is tested in [Blouppy Starter](https://starter.blouppy.com/).


## References
- [Choosing a testing strategy](https://learn.microsoft.com/ef/core/testing/choosing-a-testing-strategy) (Microsoft Learn) — why the in-memory provider is discouraged for testing.
- [Testing against your production database system](https://learn.microsoft.com/ef/core/testing/testing-with-the-database) (Microsoft Learn) — fixtures and cleanup with a real database.
- [Applying migrations](https://learn.microsoft.com/ef/core/managing-schemas/migrations/applying) (Microsoft Learn) — `MigrateAsync` versus `EnsureCreated`.
- [ExecuteUpdate and ExecuteDelete](https://learn.microsoft.com/ef/core/saving/execute-insert-update-delete) (Microsoft Learn) — bulk updates that bypass the change tracker.
- [Microsoft.Testing.Platform overview](https://learn.microsoft.com/dotnet/core/testing/microsoft-testing-platform-intro) (Microsoft Learn) — the runner behind `--filter-class`.
- [PostgreSQL module](https://dotnet.testcontainers.org/modules/postgres/) (Testcontainers for .NET) — `PostgreSqlBuilder` and its options.
- [Shared context between tests](https://xunit.net/docs/shared-context) (xUnit) — collection fixtures and `IAsyncLifetime`.
- [Respawn](https://www.nuget.org/packages/Respawn) (NuGet) — resetting a database between tests.
- [Client connection defaults](https://www.postgresql.org/docs/current/runtime-config-client.html) (PostgreSQL) — `session_replication_role`.
- [Repositories tested on real PostgreSQL](https://docs.starter.blouppy.com/choices/real-database-tests/) (Blouppy Starter docs) — the choice and its costs.
