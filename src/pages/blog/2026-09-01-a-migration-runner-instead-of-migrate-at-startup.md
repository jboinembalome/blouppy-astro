---
templateKey: 'blog-post'
title: 'A migration runner instead of Database.Migrate() at startup'
date: 2026-09-01T09:00:00.000Z
updated: 2026-11-07T09:00:00.000Z
author: Jimmy Boinembalome
authorimage: /img/jimmy.jpg
category: C#
topic: 'Data'
illustration: 1
categorycolor: bg-purple-100 text-purple-800
featuredpost: true
featuredimage: /img/a-migration-runner-instead-of-migrate-at-startup.jpg
description: >-
  Learn how to move EF Core migrations out of your services and into a small worker that runs once, exits, and gates everything else.
tags:
  - Development
  - C#
  - EF Core
  - PostgreSQL
  - .NET Aspire
---

The quickest way to keep a database up to date with EF Core is one line in `Program.cs`: `context.Database.Migrate()` before `app.Run()`. It works on a laptop. Then we deploy two replicas, or a second service with its own `DbContext`, or a message bus and a job scheduler with their own tables, and "who creates what, and when" no longer has a clear answer.

The fix is to give that job to one process whose only purpose is to migrate: it runs before everything else, applies every schema, then exits, and its exit code decides whether the services may start.

In this article, we will build that runner as a .NET worker, guard it against Production, wire it into Aspire with `WaitForCompletion` and into Docker Compose, and see why seeding stays with the services.


## What goes wrong with Migrate() at startup
Each failure shapes the design:
- **Replicas race.** Two instances of the same service both see a pending migration and both try to apply it.
- **Services start against a foreign schema.** In the code base this article comes from, four EF Core contexts share one PostgreSQL database: `BlouppyDbContext`, `BillingDbContext`, the identity host's `ApplicationDbContext` and the gateway's `GatewayDbContext`. If each host migrates its own, the API can start while the identity host is still creating tables the API reads.
- **Non-EF tables have no owner.** Wolverine's outbox, inbox and dead letters, and Quartz.NET's clustered job store, live in the same database. If each host builds them on the way up, the race simply moves.
- **Production changes by accident.** Every process start becomes a schema change.

The EF Core documentation on [applying migrations](https://learn.microsoft.com/ef/core/managing-schemas/migrations/applying) makes the same point: a separate migration step is preferred when review, least-privilege credentials, coordinated rollout or high availability matter.

> **_Note:_**  Since EF Core 9, [`Migrate()` takes a database-wide lock](https://learn.microsoft.com/ef/core/what-is-new/ef-core-9.0/whatsnew), which settles the replica race. It does not settle the rest: the order between contexts, the non-EF tables, and services starting too early.


## The runner: a worker that migrates, then stops
The runner is a plain [worker project](https://learn.microsoft.com/dotnet/core/extensions/workers) (`Microsoft.NET.Sdk.Worker`). It references the projects that own each context, so the migrations stay where `dotnet ef migrations add` puts them; the runner adds none of its own. Here is `back/Blouppy.MigrationRunner/Program.cs`:

```csharp
var builder = Host.CreateApplicationBuilder(args);

builder.AddServiceDefaults();

builder.Services
    .AddOptions<MigrationRunnerOptions>()
    .Bind(builder.Configuration.GetSection(MigrationRunnerOptions.SectionName));

builder.AddMigrationDbContexts();

builder.Services.AddHostedService<DatabaseMigrator>();

var host = builder.Build();

await host.RunAsync();

// The exit code the migrator set on failure. Aspire reads it to decide whether
// the resources waiting on this one may start.
return Environment.ExitCode;
```

`AddMigrationDbContexts()` registers the four contexts **directly**, not through each host's own registration. Those pull in save-changes interceptors, the whole OpenIddict server, `UserManager` and the gateway's session, none of which a migration needs. The runner stays a database tool rather than a second copy of three applications. `return Environment.ExitCode` hands the outcome of `DatabaseMigrator` to whatever orchestrates the process.

Registering the contexts directly has one price: each context's schema and history table is repeated in the runner:

```csharp
builder.Services.AddDbContext<BillingDbContext>(options => options
    .UseNpgsql(connectionString, npgsql => npgsql
        .MigrationsHistoryTable(HistoryRepository.DefaultTableName, BillingDbContext.Schema)));
```

A mismatch with the host's registration would migrate into the wrong place, so review this duplication whenever a context changes schema.


## The migrator
`DatabaseMigrator` is a `BackgroundService`:

```csharp
protected override async Task ExecuteAsync(CancellationToken stoppingToken)
{
    try
    {
        if (ShouldRunAndSayWhyNot())
        {
            await MigrateAllAsync(stoppingToken);
        }
    }
    catch (Exception exception)
    {
        logger.LogError(exception, "The database migration run failed.");

        // A non-zero exit is what tells Aspire (and a deployment pipeline) not
        // to start anything against a database whose schema is unknown.
        Environment.ExitCode = 1;
    }
    finally
    {
        lifetime.StopApplication();
    }
}
```

Any failure is logged and sets the exit code to **1**, and `finally` always calls `IHostApplicationLifetime.StopApplication()`, so the worker never lingers. `ShouldRunAndSayWhyNot()` is the Production guard, covered below. Here is the run itself:

```csharp
private async Task MigrateAllAsync(CancellationToken cancellationToken)
{
    using var scope = scopeFactory.CreateScope();

    // Order matters once: the Identity schema carries the users the rest of
    // the platform's rows are attributed to. The others are independent.
    await MigrateAsync<ApplicationDbContext>(scope, cancellationToken);
    await MigrateAsync<BlouppyDbContext>(scope, cancellationToken);
    await MigrateAsync<BillingDbContext>(scope, cancellationToken);
    await MigrateAsync<GatewayDbContext>(scope, cancellationToken);

    // Wolverine's tables, one schema per host, through Wolverine's migration rather than EF's.
    await MigrateMessageStorageAsync(BlouppyMessagingServiceCollectionExtensions.StorageSchema, cancellationToken);
    await MigrateMessageStorageAsync(IdentitySchemas.Messaging, cancellationToken);

    logger.LogInformation("All databases are up to date.");
}
```

The order is written down in one place instead of being an accident of which container started first.

`MigrateAsync<TContext>` logs the pending migrations by name (`GetPendingMigrationsAsync`), then calls `context.Database.MigrateAsync()`. Before that, it creates the database and the history table if they are missing (`IRelationalDatabaseCreator`, `IHistoryRepository.CreateIfNotExistsAsync`). On an empty database, EF otherwise queries `__EFMigrationsHistory` before it exists and logs the refused query at Error level, even though it recovers. The logs stay clean, and a real failure still stands out.


## The tables EF does not own
### Quartz.NET
Quartz.NET's [clustered ADO.NET job store](https://www.quartz-scheduler.net/documentation/quartz-3.x/tutorial/job-stores.html) needs its tables, and the scheduler in the API only *validates* them at startup. They come in as an ordinary EF migration of `BlouppyDbContext`, `AddQuartzScheduler`, whose `Up` calls `migrationBuilder.EnsureSchema(name: "quartz")` and then `migrationBuilder.Sql(...)` with Quartz's own PostgreSQL script. The runner needs nothing special for it, and a Quartz upgrade that changes those tables is a migration of its own.

### Wolverine
Only Wolverine knows the shape of [its PostgreSQL tables](https://wolverinefx.net/guide/durability/postgresql.html). The runner calls a small helper in the messaging adapter, `MessageStorage.MigrateAsync` (argument checks omitted):

```csharp
public static async Task MigrateAsync(string connectionString, string schema, CancellationToken cancellationToken = default)
{
    var builder = Host.CreateEmptyApplicationBuilder(new HostApplicationBuilderSettings());

    builder.Services.AddWolverine(ExtensionDiscovery.ManualOnly, wolverine =>
    {
        wolverine.Discovery.DisableConventionalDiscovery();
        wolverine.AutoBuildMessageStorageOnStartup = AutoCreate.None;
        wolverine.PersistMessagesWithPostgresql(connectionString, schema);
    });

    using var host = builder.Build();

    await host.Services
        .GetRequiredService<IMessageStore>()
        .Admin
        .MigrateAsync();
}
```

The host is **built but never started**, so nothing connects to RabbitMQ and no node joins the cluster. `IMessageStore.Admin.MigrateAsync()` is Wolverine's own migration, which only adds. It runs once per schema, `wolverine` for the API and `wolverine_identity` for the identity host, because one shared schema would make the two hosts one cluster.

The hosts, in turn, must stop creating these tables. The bus configuration sets `AutoBuildMessageStorageOnStartup` from a `Messaging:AutoCreateStorage` option that is off by default; only the integration tests, which have no runner, switch it on.


## Guarding Production
Applying a schema to Production should be a release step someone owns. The runner encodes that in a pure function:

```csharp
internal static bool ShouldRun(IHostEnvironment environment, MigrationRunnerOptions options)
    => options.RunOnStartup
       && (!environment.IsProduction() || options.AllowInProduction);
```

Both settings live in `MigrationRunnerOptions`, bound to the `Migrations` section. `RunOnStartup`, the master switch, is on by default, because running the project at all is a request to migrate. `AllowInProduction` defaults to `false`, so the safe state is the one we get when nobody configured anything.

Because `ShouldRun` is static and needs no database, the matrix is easy to test. Here is the case that matters most, from `DatabaseMigratorTests`:

```csharp
[Fact]
public void ShouldRun_ProductionWithDefaults_ReturnsFalse()
{
    // Arrange
    var environment = Given_an_environment(Environments.Production);
    var options = new MigrationRunnerOptions();

    // Act
    var shouldRun = DatabaseMigrator.ShouldRun(environment, options);

    // Assert
    shouldRun.Should().BeFalse();
}
```

The other tests cover Development and Staging with defaults, Production opted in, and `RunOnStartup = false` in every environment.

> **_Note:_**  Skipping is not failing: when the guard says no, the runner logs a warning and exits **0**. That is intended, but it means the [environment name](https://learn.microsoft.com/aspnet/core/fundamentals/environments) has to be right, as the Aspire wiring shows.


## Wiring it into Aspire
In the AppHost (`back/Blouppy.Aspire.AppHost/Program.cs`), the runner is a project resource, and each host waits for it to *complete*:

```csharp
var migrations = builder.Environment.IsProduction()
    ? null
    : builder.AddProject<Projects.Blouppy_MigrationRunner>("blouppy-migrations")
        .WithEnvironment("DOTNET_ENVIRONMENT", builder.Environment.EnvironmentName)
        .WithReference(blouppyDb)
        .WaitFor(blouppyDb);

// ...

if (migrations is not null)
{
    blouppyApi = blouppyApi.WaitForCompletion(migrations);
}
```

- `WaitForCompletion(migrations)` holds the API, the identity host and the gateway until the runner has exited successfully. On a non-zero exit, they never start.
- The runner is left out of a Production graph entirely, a second guard independent of `AllowInProduction`.
- `DOTNET_ENVIRONMENT` is the subtle line. A worker reads `DOTNET_ENVIRONMENT`, while Aspire hands a project `ASPNETCORE_ENVIRONMENT`. Without it, the runner comes up as Production, its guard skips everything, it exits 0, and every other resource starts against a database nobody migrated.


## Wiring it into Docker Compose
Compose has the same idea built in. In `deploy/docker-compose.yml`, the runner is a one-shot service built from the shared `back/Dockerfile` (abridged):

```yaml
migrations:
  restart: "no"
  build:
    context: ../back
    args:
      PROJECT: Blouppy.MigrationRunner
  depends_on:
    postgres:
      condition: service_healthy

api:
  depends_on:
    migrations:
      condition: service_completed_successfully
```

[`service_completed_successfully`](https://docs.docker.com/compose/how-tos/startup-order/) is Compose's equivalent of `WaitForCompletion`: the gateway, the identity host and the API start only once `migrations` has exited 0. The deployment's owner decides with `Migrations__AllowInProduction` in `deploy/.env`: `true` migrates on every `docker compose up`, `false` leaves it to an explicit step:

```bash
docker compose run --rm -e Migrations__AllowInProduction=true migrations
```

Without Aspire or Compose, it is the same image run as a one-off job with the `blouppy-db` connection string, and the hosts roll out after it exits 0.


## Seeding stays with the services
The runner creates schema, never rows. Seeding needs `UserManager`, `RoleManager` and the domains' own services, and is only wanted in some environments; migrating needs none of that. Each host seeds its own data, and both ask one shared question, from `Blouppy.Aspire.ServiceDefaults/Database/DataSeedingOptions.cs`:

```csharp
public static bool IsDataSeedingEnabled(this IHostEnvironment environment, IConfiguration configuration)
    => configuration.GetValue<bool?>(EnabledKey) ?? environment.IsDevelopment();
```

Development seeds and everything else does not; `Seed:Enabled` overrides it in either direction. In the API, `true` registers a `SampleDataSeeder` hosted service. This split is what lets the runner run against any environment without writing sample rows into it.


## Conclusion
`Database.Migrate()` at startup mixes two decisions that should be separate: starting a service and changing a schema. A worker that runs once and exits gives every schema one owner (the EF contexts, Quartz.NET's tables, Wolverine's storage), a fixed order, and an exit code that gates everything else.

The cost is one more project that references every context's assembly, and one more deployment step. In return, Aspire's `WaitForCompletion` and Compose's `service_completed_successfully` do the gating, and two independent guards keep Production from changing by accident.

This is how migrations are applied in [Blouppy Starter](https://starter.blouppy.com/). The [migration runner's documentation](https://docs.starter.blouppy.com/choices/migration-runner/) explains the trade-offs.


## References
- [Applying migrations](https://learn.microsoft.com/ef/core/managing-schemas/migrations/applying) — EF Core's strategies, and why runtime migration is a trade-off.
- [What's new in EF Core 9](https://learn.microsoft.com/ef/core/what-is-new/ef-core-9.0/whatsnew) — protection against concurrent migrations.
- [Worker services in .NET](https://learn.microsoft.com/dotnet/core/extensions/workers) — the worker template and `BackgroundService`.
- [Use multiple environments in ASP.NET Core](https://learn.microsoft.com/aspnet/core/fundamentals/environments) — `ASPNETCORE_ENVIRONMENT` and `DOTNET_ENVIRONMENT`.
- [Docker Compose to AppHost reference](https://aspire.dev/app-host/docker-compose-to-apphost-reference/) — `WaitFor` and `WaitForCompletion` against Compose's `depends_on` conditions.
- [Control startup order in Compose](https://docs.docker.com/compose/how-tos/startup-order/) — `service_healthy` and `service_completed_successfully`.
- [Wolverine: PostgreSQL integration](https://wolverinefx.net/guide/durability/postgresql.html) — Wolverine's message storage tables.
- [Quartz.NET: Job stores](https://www.quartz-scheduler.net/documentation/quartz-3.x/tutorial/job-stores.html) — the ADO.NET job store and its tables.
- [Blouppy Starter: Migration runner](https://docs.starter.blouppy.com/choices/migration-runner/) — the runner's design choices.
