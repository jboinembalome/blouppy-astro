---
templateKey: 'blog-post'
title: 'Testing EF Core repositories on a real PostgreSQL with Testcontainers'
date: 2026-07-15T09:00:00.000Z
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

A repository is mostly a conversation with the database: the SQL that EF Core translates our LINQ into, the constraints, the collations, the sequences, the transactions. The EF Core **in-memory provider** has none of those. A test can be green on it and fail on PostgreSQL, or the other way round, and an `ExecuteUpdateAsync` does not even run on it.

There is a second trap, and it hides even on a real database: a test that adds an entity and reads it back with the **same `DbContext`** passes because the change tracker still holds the entity, whether or not it was ever saved.

In this article, we will build repository tests that start a real PostgreSQL in a container with **Testcontainers**, apply the real migrations, reset the data between tests, and use three separate `DbContext` instances: one to arrange, one to act, one to assert.


## Prerequisites
Before to start you will need:
- The [.NET 10 SDK](https://dotnet.microsoft.com/en-us/download/dotnet/10.0).
- [Docker](https://www.docker.com/), wherever the tests run, CI included.

The test project references `xunit.v3`, `AutoFixture`, `FluentAssertions`, `Moq`, `Respawn` and `Testcontainers.PostgreSql`.


## One container per test project
Let's start with the class that owns the container:

```csharp
using Npgsql;
using Respawn;
using Testcontainers.PostgreSql;

public sealed class Database
{
    private const string DefaultDatabase = "BlouppyIntegrationTestDb";
    private DbConnection _connection = null!;
    private Respawner _respawner = null!;

    private readonly PostgreSqlContainer _dbContainer = new PostgreSqlBuilder(image: "postgres:17.5")
        .WithAutoRemove(true)
        .WithPassword("Strong_password_123!")
        .WithName(DefaultDatabase)
        .Build();

    public async Task StartContainerAsync()
        => await _dbContainer.StartAsync();

    public string GetConnectionString()
    {
        var builder = new NpgsqlConnectionStringBuilder(_dbContainer.GetConnectionString())
        {
            Database = DefaultDatabase
        };

        return builder.ConnectionString;
    }
}
```

Here is what it does:
- `PostgreSqlBuilder` pins the image to `postgres:17.5`, a version we chose rather than whatever `latest` is today.
- `WithAutoRemove(true)` lets Docker remove the container when it stops.
- `GetConnectionString()` points the container's connection string at our own database.

Starting a container takes seconds, so we do it **once for the whole test project**, not once per test. With xUnit, that is a collection fixture:

```csharp
[CollectionDefinition("Database collection")]
public class DatabaseCollection : ICollectionFixture<DatabaseFixture>
{
}
```

Every test class tagged `[Collection("Database collection")]` shares the same `DatabaseFixture`, and therefore the same container. It also means those classes do not run in parallel with each other, which is what we want: they share one database.


## Apply the real migrations
The schema the tests run on must be the one production runs on. `EnsureCreated()` would build a schema from the model, skipping everything the migrations do by hand (a data fix, a view, a unique index added later). So the fixture runs `MigrateAsync()`:

```csharp
public sealed class DatabaseFixture : IAsyncLifetime
{
    public Database Database { get; } = new();
    public Mock<ICurrentUserService> CurrentUserServiceMock { get; private set; }

    public async ValueTask InitializeAsync()
    {
        await Database.StartContainerAsync();

        CurrentUserServiceMock = new Mock<ICurrentUserService>();
        InitializeCurrentUser(new UserId("00000000-0000-0000-0000-000000000000"));

        var serviceProvider = ConfigureServicesInternal()
            .AddEntityFrameworkNpgsql()
            .BuildServiceProvider();

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

    public BlouppyDbContext CreateBlouppyDbContext()
        => new(_blouppyDbContextOptions);
}
```

A few decisions are worth explaining:
- The migrations run **once per collection**, in `InitializeAsync`, and never in a test.
- The identity host's `ApplicationDbContext` is migrated **first**: in this code base the application's `users_view` reads a table that the identity migrations create. The order is the one the production migration runner uses.
- The options carry the **real `SaveChangesInterceptor`s** (`CreatedEntityInterceptor`, `ModifiedEntityInterceptor`, `PublishDomainEventsInterceptor`), so the audit columns are filled exactly as in production.
- `ICurrentUserService` is a `Mock`, because the interceptors ask who the current user is.
- The `IDomainEventPublisher` is a stub (`DomainEventPublisherStub`): we test the repository, not the event handlers.


## Reset the data between tests
With one database for every test, each test must start from empty tables. Recreating the database would mean migrating again, so the code uses **Respawn**, which deletes the rows and keeps the schema:

```csharp
_respawner = await Respawner.CreateAsync(_connection, new RespawnerOptions
{
    TablesToIgnore = ["__EFMigrationsHistory"],
    SchemasToInclude = [Schemas.Public, Schemas.Blouppy],
    DbAdapter = new PostgresDeleteAdapter()
});
```

`__EFMigrationsHistory` is ignored, otherwise the next run would believe no migration was ever applied.

`PostgresDeleteAdapter` is a custom `IDbAdapter`, and its reason is a nice measurement. A reset runs after every test, and a test writes a handful of rows into a few of the ~80 tables. Respawn's PostgreSQL adapter issues a `TRUNCATE`, which costs the same whatever a table holds: about 100 ms a test, more than the test itself. A `DELETE` of an empty table costs nothing, so the reset drops to a few milliseconds:

```csharp
public string BuildDeleteCommandText(GraphBuilder graph, RespawnerOptions options)
{
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

`session_replication_role = replica` switches the foreign keys off for the reset, so neither the order of the tables nor a cycle between them matters. It needs a superuser, which is what a Testcontainers database runs as. 😉


## Three DbContexts: arrange, act, assert
Now the heart of it. Here is the base class every repository test inherits from:

```csharp
[Collection("Database collection")]
public abstract class DatabaseTestsBase : IAsyncDisposable
{
    private readonly DatabaseFixture _databaseFixture;
    private readonly ApplicationDbContext _arrangeIdentityDbContext;

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

    protected IFixture Builder { get; }
    protected BlouppyDbContext ArrangeDbContext { get; }
    protected BlouppyDbContext ActDbContext { get; }
    protected BlouppyDbContext AssertDbContext { get; }
    protected DataSeed DataSeed { get; }

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

Why three contexts?
- `ArrangeDbContext` writes the rows the test needs. Whatever it tracks stays in its own change tracker.
- `ActDbContext` is the one the repository under test receives. It starts empty, as it would in a real request.
- `AssertDbContext` has never seen any entity, so every query it runs **goes to PostgreSQL**. If the repository forgot a column, a mapping or a `SaveChanges`, the assertion sees it.
- `DisposeAsync` disposes the three contexts and resets the database, so the next test starts clean.

With a single context, `FirstAsync(x => x.Id == workspace.Id)` would often hand back the very instance we added, straight from the identity map. The test would assert that an object is equivalent to itself.


## Seed the data with Given_a_*() helpers
Each test builds the rows it asserts against, rather than relying on sample data. The helpers are grouped by entity in a `DataSeed`, and they write through the arrange context:

```csharp
public sealed class WorkspaceDataSeed(
    DataSeed dataSeed,
    IFixture builder,
    BlouppyDbContext arrangeDbContext)
{
    public async Task<Workspace> Given_a_Workspace(UserId ownerId, OrganizationId organizationId)
    {
        var workspace = builder.Create<Workspace>();
        workspace.SetProperty(x => x.OwnerId, ownerId);
        workspace.SetProperty(x => x.OrganizationId, organizationId);

        await arrangeDbContext.Workspaces.AddAsync(workspace);
        await arrangeDbContext.SaveChangesAsync();

        return workspace;
    }
}
```

`builder` is an AutoFixture `Fixture` customized for a real database, and that is where PostgreSQL leaks into the test data:

```csharp
public sealed class DatabaseEntityFixture : Fixture
{
    public DatabaseEntityFixture()
    {
        Customize(new MicrosecondDateTimeOffsetCustomization());
        Customize(new UserIdCustomization());
        Customize(new AmountCustomization());

        Customizations.Add(new PropertyNameOmitterSpecimenBuilder(
            nameof(EntityBase<object>.Id),
            nameof(ICreatedAtEntity.CreatedBy),
            nameof(ICreatedAtEntity.CreatedDate),
            nameof(IModifiedAtEntity.LastModifiedBy),
            nameof(IModifiedAtEntity.LastModifiedDate)));
    }
}
```

- `MicrosecondDateTimeOffsetCustomization` truncates every generated `DateTimeOffset` to the microsecond (`TruncateMicroseconds()`). .NET counts in 100-nanosecond ticks, PostgreSQL stores microseconds, so a random date would come back a few ticks different and fail an equivalency check. The in-memory provider would never show us that.
- `PropertyNameOmitterSpecimenBuilder` leaves `Id` and the audit columns alone: the HiLo sequence assigns the id and the interceptors fill the audit columns, exactly as in production.


## Exclude the domain events once, with [ModuleInitializer]
Our aggregates inherit `HasDomainEventsBase` and raise domain events. The handlers live in the application layer, so in these tests a save dispatches nothing, and an entity read back has none of the events its expected copy raised. `BeEquivalentTo` would fail on every aggregate.

The fix is one global FluentAssertions option, in `DatabaseEntityFixture`:

```csharp
// Once, at load, rather than every time a fixture is created, and whether or not a test creates one: the domain
// event handlers live in the application layer, so a save here dispatches nothing and an entity read back has
// none of the events its expected copy raised.
[ModuleInitializer]
internal static void ExcludeDomainEvents()
    => AssertionOptions.AssertEquivalencyUsing(options => options
        .Excluding(x => x.Path == nameof(HasDomainEventsBase.DomainEvents)));
```

A `[ModuleInitializer]` runs when the assembly loads, before any test. A static constructor would be the tempting alternative, but it only runs when its class is first touched, and a test class that never creates a `DatabaseEntityFixture` may run before it.


## A repository test
Let's put it all together with `WorkspacesRepositoryTests`:

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

The repository gets `ActDbContext`, the organization comes from a `Given_an_Organization()` helper (the foreign key is real, so a workspace needs one), and the assertion reads back through `AssertDbContext`.

The tests that need a real database the most are the ones that go around the change tracker. `TransferOwnershipAsync` is a single `ExecuteUpdateAsync`, which the in-memory provider cannot run:

```csharp
// Act
var transferred = await _sut.TransferOwnershipAsync(organization.Id, leaver, newOwner, TestContext.Current.CancellationToken);

// Assert
var owners = await AssertDbContext.Workspaces
    .Where(x => x.Id == owned.Id || x.Id == notOwned.Id || x.Id == elsewhere.Id)
    .ToDictionaryAsync(x => x.Id, x => x.OwnerId, TestContext.Current.CancellationToken);

owners
    .Should()
    .BeEquivalentTo(new Dictionary<WorkspaceId, UserId>
    {
        [owned.Id] = newOwner,
        [notOwned.Id] = someoneElse,
        [elsewhere.Id] = leaver
    });
```

The test seeds three workspaces: the one that must move, one owned by someone else, and one owned by the same person in another organization. The two that must not change are what test the `Where` clause.

Constraints are tested the same way. Here a webhook points at an organization that does not exist, and PostgreSQL refuses it:

```csharp
var webhook = new Webhook(new OrganizationId(int.MaxValue), "https://example.com/hooks", [WebhookEventType.WorkspaceCreated]);

await _sut.AddAsync(webhook, TestContext.Current.CancellationToken);

var act = () => ActDbContext.SaveChangesAsync(TestContext.Current.CancellationToken);

await act.Should()
    .ThrowAsync<DbUpdateException>();
```

On the in-memory provider, that save succeeds. 👍


## Run one class while iterating
The test project runs on **Microsoft.Testing.Platform**, selected by `"test": { "runner": "Microsoft.Testing.Platform" }` in `back/global.json`. So from `back/`, `dotnet test` takes a `--project` and a `--filter-class`:

```bash
cd back
dotnet test --project Blouppy.Infrastructure.Database.IntegrationTests/Blouppy.Infrastructure.Database.IntegrationTests.csproj \
  --filter-class "*WorkspacesRepositoryTests"
```

The container still starts once for the run, but only one class executes.


## What it costs
Nothing here is free, and it is worth saying so:
- **Docker** is required wherever the tests run, CI included.
- **Time**: a container per test project, and slower tests than an in-memory fake.
- **Writing the data**: every test builds its own rows through `Given_a_*()` helpers.

What we keep fast is everything else. Services, validators and handlers are unit tested with mocked ports; only the adapters touch a container.


## Conclusion
The in-memory provider tests a database that does not exist. Starting a real PostgreSQL with Testcontainers, applying the real migrations once per collection and resetting the rows with Respawn gives us tests that fail for the reasons production would.

Three `DbContext` instances close the other gap: the arrange context seeds, the act context is the repository's, and the assert context, which has never tracked anything, reads what PostgreSQL really stored. A microsecond-truncated `DateTimeOffset` and a `[ModuleInitializer]` that excludes `DomainEvents` keep `BeEquivalentTo` honest.

This is how the database adapter is tested in [Blouppy Starter](https://starter.blouppy.com/), and the [real database tests page](https://docs.starter.blouppy.com/choices/real-database-tests/) explains the choice and its costs.

*Thanks for reading! 🙂*
