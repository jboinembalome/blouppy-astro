---
templateKey: 'blog-post'
title: 'A module with its own DbContext and PostgreSQL schema'
date: 2027-01-21T09:00:00.000Z
author: Jimmy Boinembalome
authorimage: /img/jimmy.jpg
category: C#
topic: 'Data'
illustration: 2
categorycolor: bg-purple-100 text-purple-800
featuredpost: true
description: >-
  Learn how to give a .NET module its own EF Core DbContext, PostgreSQL schema and migrations history, and what it costs: no cross-context joins, a shared transaction and one outbox.
tags:
  - Development
  - C#
  - EF Core
  - PostgreSQL
---

A single `DbContext` grows with the application: every module adds its `DbSet`s to it, and any class holding the context can read any table. The boundary between modules exists in the folder structure, and nowhere in the data.

EF Core lets several contexts share one database. Each one maps its own tables, in its own PostgreSQL schema, with its own migrations. In this article, we will give a module its own `DbContext`, schema and migrations history, see how the tools and a migration runner deal with several contexts, and look honestly at the price: no foreign keys or joins across contexts, transactions that need care, and an outbox that belongs to one context only.


## The idea in one context
A module context is an ordinary `DbContext` that declares its schema and maps only its own entities. Here is a minimal one for an invoicing module:

```csharp
namespace Invoicing.Infrastructure.Database;

public sealed class InvoicingDbContext(
    DbContextOptions<InvoicingDbContext> options)
    : DbContext(options)
{
    public const string Schema = "invoicing";

    internal DbSet<Invoice> Invoices => Set<Invoice>();

    protected override void OnModelCreating(ModelBuilder modelBuilder)
    {
        modelBuilder.HasDefaultSchema(Schema);

        modelBuilder.ApplyConfigurationsFromAssembly(typeof(InvoicingDbContext).Assembly);
    }
}
```

- [`HasDefaultSchema`](https://learn.microsoft.com/ef/core/modeling/entity-types#table-schema) puts every table, sequence and index of the model in `invoicing`, and the first migration starts with `EnsureSchema("invoicing")`.
- The `DbSet`s are `internal`: outside the module, nothing can query its tables, even with the context in hand.

The second half is the registration. Each context has its own [migrations history table](https://learn.microsoft.com/ef/core/managing-schemas/migrations/history-table), and we name its schema explicitly so that it sits beside the module's tables:

```csharp
services.AddDbContext<InvoicingDbContext>(options => options
    .UseNpgsql(connectionString, npgsql => npgsql
        .MigrationsHistoryTable(HistoryRepository.DefaultTableName, InvoicingDbContext.Schema)));
```

We end up with `invoicing.__EFMigrationsHistory` next to `app.__EFMigrationsHistory`. The two histories never see each other's rows, so two teams can add migrations to their contexts on the same day without a conflict in the snapshot or in the history.


## Billing, a real module
In [Blouppy Starter](https://starter.blouppy.com/), the billing module owns its data this way. The [billing article](/blog/2026-10-01-billing-module-behind-an-adapter/) explains why billing is a module and how Stripe stays behind a port; here we only look at its persistence. `BillingDbContext` is in the module's project, `Blouppy.Billing`:

```csharp
namespace Blouppy.Billing.Infrastructure.Database;

public class BillingDbContext(
    DbContextOptions<BillingDbContext> options)
    : DbContext(options)
{
    public const string Schema = "billing";

    internal DbSet<Plan> Plans { get; set; }
    internal DbSet<Subscription> Subscriptions { get; set; }

    protected override void OnModelCreating(ModelBuilder builder)
    {
        var assembly = typeof(BillingDbContext).Assembly;

        builder.HasDefaultSchema(Schema);

        builder.ApplyConfigurationsFromAssembly(assembly);

        base.OnModelCreating(builder);
    }
}
```

The application's `BlouppyDbContext` does the same with the `blouppy` schema, and the gateway has a third, even smaller one. `GatewayDbContext` maps a single table, the Data Protection key ring that encrypts the session cookie, in the `gateway` schema:

```csharp
public sealed class GatewayDbContext(DbContextOptions<GatewayDbContext> options)
    : DbContext(options), IDataProtectionKeyContext
{
    public const string Schema = "gateway";

    public DbSet<DataProtectionKey> DataProtectionKeys => Set<DataProtectionKey>();

    protected override void OnModelCreating(ModelBuilder modelBuilder)
    {
        modelBuilder.HasDefaultSchema(Schema);

        modelBuilder.Entity<DataProtectionKey>(builder => builder.ToTable("data_protection_keys"));
    }
}
```

The gateway is a separate host. It has no reason to know the application's model, and the application has no reason to read the gateway's keys. Its context is the smallest thing that lets [`PersistKeysToDbContext<GatewayDbContext>()`](https://learn.microsoft.com/aspnet/core/security/data-protection/implementation/key-storage-providers#entity-framework-core) work, and it lives in the same PostgreSQL database as the others.


## The tools with several contexts
With more than one context in a startup project, `dotnet ef` refuses to guess, and every command needs `-c`. The billing migration is added through the Web host, with the module as the target project:

```bash
dotnet ef migrations add Add_Plan_AllowsSso \
  -s back/Blouppy.Web -p back/Blouppy.Billing \
  -c BillingDbContext -o Infrastructure/Database/Migrations
```

`-p` decides where the migration files go, so the billing migrations stay in the billing project, under the module's own folder.

Going through the Web host has a cost: the tools boot it, with all the configuration it needs. Both new contexts avoid that with an [`IDesignTimeDbContextFactory<T>`](https://learn.microsoft.com/ef/core/cli/dbcontext-creation#from-a-design-time-factory), which the tools use when they find one in the context's project or the startup project. The gateway's factory never connects, because generating a migration only reads the model:

```csharp
internal sealed class GatewayDbContextDesignTimeFactory : IDesignTimeDbContextFactory<GatewayDbContext>
{
    public GatewayDbContext CreateDbContext(string[] args)
        => new(new DbContextOptionsBuilder<GatewayDbContext>()
            .UseNpgsql("Host=localhost;Database=design-time", npgsql => npgsql
                .MigrationsHistoryTable(HistoryRepository.DefaultTableName, GatewayDbContext.Schema))
            .Options);
}
```

`BillingDbContextFactory` does the same, and reads `ConnectionStrings__blouppy-db` from the environment for the one command that does connect, `database update`.

Notice that the history table's schema is now written in three places: the host's registration, the design-time factory and, as we will see, the migration runner. They must agree. A factory that forgets `MigrationsHistoryTable` generates the same migration files, but `database update` would record them in another history table and try to apply them again.


## Applying several contexts in order
Several contexts means several `Migrate()` calls, and someone has to decide their order. [A migration runner](/blog/2026-09-01-a-migration-runner-instead-of-migrate-at-startup/) covers that worker in detail: it runs once, before the hosts, and exits. What matters here is that the order is written in one method:

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
}
```

`ApplicationDbContext` owns `public`, `BlouppyDbContext` `blouppy`, `BillingDbContext` `billing` and `GatewayDbContext` `gateway`. Each context's history is checked independently: billing can have two pending migrations while the application has none, and the runner logs exactly that.


## Cost 1: no foreign key, no join
A foreign key is part of a model, and a model belongs to one context. `Subscription` has an `OrganizationId`, but `organizations` is in `BlouppyDbContext`, so the billing migration creates a plain integer column:

```csharp
migrationBuilder.CreateTable(
    name: "subscriptions",
    schema: "billing",
    columns: table => new
    {
        id = table.Column<int>(type: "integer", nullable: false),
        organization_id = table.Column<int>(type: "integer", nullable: false),
        // ...
    },
    constraints: table =>
    {
        table.PrimaryKey("pk_subscriptions", x => x.id);
    });
```

PostgreSQL would accept a constraint across schemas, and we could add one by hand with `migrationBuilder.Sql`. We do not, because it would couple the two migration histories again: dropping the module would now need a migration in the application.

The consequences are real:

- **Nothing cascades.** Deleting an organization leaves its subscription row. Billing listens for `OrganizationDeletedIntegrationEvent` and cancels it, through `CancelSubscriptionWhenOrganizationDeletedIntegrationEventHandler`. The same goes for an account erasure: the erasure's transaction runs over `BlouppyDbContext`, so billing anonymizes its own rows when `AccountErasedIntegrationEvent` arrives (see [GDPR data export and account erasure](/blog/2026-10-07-gdpr-data-export-and-account-erasure/)).
- **No LINQ join across contexts.** A query that needs organizations and subscriptions together becomes two queries, or a projection kept by events, which is what the entitlements projection is.
- **Orphans are possible** between the moment the organization goes and the moment the event is handled. Every handler must cope with a row that is already gone, or already handled.


## Cost 2: one transaction across two contexts
Sometimes the module's rows and the application's rows must commit together. In the Starter, they must: when a subscription changes, its domain events publish integration events, and those land in the application's outbox. Two `SaveChanges` calls in two transactions would allow the subscription to commit without its message.

Two contexts can share a transaction only if they share a connection. `BillingUnitOfWork` borrows the application's:

```csharp
internal sealed class BillingUnitOfWork(
    BillingDbContext dbContext,
    IUnitOfWork unitOfWork) : IBillingUnitOfWork
{
    public async Task CommitAsync(CancellationToken cancellationToken = default)
    {
        try
        {
            await unitOfWork.CommitAsync(
                async (transaction, token) =>
                {
                    if (dbContext.Database.GetDbConnection() != transaction.Connection)
                    {
                        dbContext.Database.SetDbConnection(transaction.Connection, contextOwnsConnection: false);
                    }

                    await dbContext.Database.UseTransactionAsync(transaction, token);

                    // Accepted only once committed: a retried commit has to save the same changes again.
                    await dbContext.SaveChangesAsync(acceptAllChangesOnSuccess: false, token);
                },
                cancellationToken);

            dbContext.ChangeTracker.AcceptAllChanges();
        }
        finally
        {
            await dbContext.Database.UseTransactionAsync(null, cancellationToken);
        }
    }
}
```

On the other side, the application's `UnitOfWork` opens the transaction inside the [execution strategy](https://learn.microsoft.com/ef/core/miscellaneous/connection-resiliency#execution-strategies-and-transactions), lets the other context save first, then saves its own:

```csharp
await strategy.ExecuteAsync(async () =>
{
    await using var transaction = await BeginTransactionAsync(cancellationToken);

    // The other context saves first: the outbox rows its domain events publish land in this one.
    await alongside(transaction.GetDbTransaction(), cancellationToken);

    await dbContext.SaveChangesAsync(cancellationToken);

    await transaction.CommitAsync(cancellationToken);
});
```

Three details carry the weight:

- `SetDbConnection(..., contextOwnsConnection: false)`: the billing context uses the connection without closing or disposing it.
- `acceptAllChangesOnSuccess: false`: if the strategy retries the whole block after a transient failure, the billing changes are still tracked and saved again. They are accepted only after the commit succeeded.
- This works because both contexts point at the **same database**. A second database would need a distributed transaction, which is exactly what we want to avoid. The [EF Core transactions page](https://learn.microsoft.com/ef/core/saving/transactions#share-connection-and-transaction) describes the same sharing.


## Cost 3: the outbox belongs to one context
Wolverine's outbox tables are mapped into one context per host. In the API, that is `BlouppyDbContext`. The billing context has no outbox, so a message raised by a billing change can only be stored when `BlouppyDbContext` saves. That is the reason for the order above, and the reason why the module depends on `IUnitOfWork` from the application's database port. The [outbox article](/blog/2026-05-28-domain-events-vs-integration-events-and-the-outbox/) explains what the outbox guarantees.

Giving the module an outbox of its own would cut that dependency, at the price of a second set of message tables and a second outbox to configure and watch for the same bus. With one database, borrowing the transaction is the simpler choice.


## When one shared DbContext is better
A context per module is not free, and often not worth it:

- **The data is one model.** If the "module" constantly joins the core tables, needs foreign keys into them, or cascades with them, it is part of the core model. Splitting it only replaces SQL guarantees with event handlers.
- **The module cannot be removed anyway.** The main benefit of a separate schema is that the module can be dropped, or later moved to its own database, with nothing else to migrate. If that never happens, the boundary can be protected by `internal` types and [architecture tests](/blog/2026-07-03-architecture-tests-that-fail-the-build/) inside one context.
- **The team is small and migrations rarely conflict.** Separate histories solve a coordination problem. Without the problem, they are three more places to keep a schema name in sync.
- **Most writes span both.** If nearly every use case needs the shared-transaction dance, one context with several schemas (`ToTable("plans", "billing")`) keeps the organisation in the database without the second context.

A separate host is a different case. The gateway has its own process, its own deployment and a single table; sharing the application's context would mean referencing the whole application model from the gateway. There, a small context of its own is the obvious choice.


## Conclusion
A module's own `DbContext` gives its data the same boundary its code has: its own schema, its own history, `internal` sets nobody else can query, and migrations that never collide with the application's. The tools handle it with `-c` and a design-time factory, and a migration runner applies the contexts in a fixed order.

The price is everything the database used to do for us across that boundary: foreign keys, cascades, joins and a single `SaveChanges`. In Blouppy Starter, billing pays it with integration events and a borrowed transaction, because billing is meant to be removable. A slice of the core model should stay in the core context.


## References
- [Migrations history table (Microsoft Learn)](https://learn.microsoft.com/ef/core/managing-schemas/migrations/history-table) — `MigrationsHistoryTable` and its schema.
- [Entity types: table schema (Microsoft Learn)](https://learn.microsoft.com/ef/core/modeling/entity-types#table-schema) — `HasDefaultSchema` and per-table schemas.
- [Design-time DbContext creation (Microsoft Learn)](https://learn.microsoft.com/ef/core/cli/dbcontext-creation) — how the tools find a context, and `IDesignTimeDbContextFactory<T>`.
- [EF Core tools reference (Microsoft Learn)](https://learn.microsoft.com/ef/core/cli/dotnet) — the `--context`, `--project` and `--startup-project` options.
- [Using transactions (Microsoft Learn)](https://learn.microsoft.com/ef/core/saving/transactions) — sharing a connection and a transaction between contexts.
- [Connection resiliency (Microsoft Learn)](https://learn.microsoft.com/ef/core/miscellaneous/connection-resiliency) — execution strategies and user-initiated transactions.
- [Key storage providers (Microsoft Learn)](https://learn.microsoft.com/aspnet/core/security/data-protection/implementation/key-storage-providers) — `PersistKeysToDbContext` and `IDataProtectionKeyContext`.
- [Blouppy Starter](https://starter.blouppy.com/) — the starter kit the examples come from.
