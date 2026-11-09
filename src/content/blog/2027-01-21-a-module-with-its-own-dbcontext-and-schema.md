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

A single `DbContext` grows with the application. Every module adds its `DbSet`s to it, and any class holding the context can read any table. The boundary between modules exists in the folders, and nowhere in the data.

EF Core lets several contexts share one database. Each one maps its own tables, in its own PostgreSQL schema, with its own migrations. That gives a module a real boundary, and takes away a few things the database used to do for us.


## A context per module
A module context is an ordinary `DbContext` that declares its schema and maps only its own entities. Here is one for an invoicing module:

```csharp
public sealed class InvoicingDbContext(DbContextOptions<InvoicingDbContext> options)
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

// Registration: the history table sits in the module's schema too.
services.AddDbContext<InvoicingDbContext>(options => options
    .UseNpgsql(connectionString, npgsql => npgsql
        .MigrationsHistoryTable(HistoryRepository.DefaultTableName, InvoicingDbContext.Schema)));
```

[`HasDefaultSchema`](https://learn.microsoft.com/ef/core/modeling/entity-types#table-schema) puts every table, sequence and index of the model in `invoicing`. The `DbSet`s are `internal`, so nothing outside the module can query its tables, even with the context in hand.

Each context gets its own [migrations history table](https://learn.microsoft.com/ef/core/managing-schemas/migrations/history-table): `invoicing.__EFMigrationsHistory` next to the application's. Two teams can add migrations on the same day without a conflict in the snapshot or in the history.

[Blouppy Starter](https://starter.blouppy.com/) does exactly this for its billing module: `BillingDbContext`, schema `billing`, beside the application's `BlouppyDbContext` in `blouppy`. The gateway has a third context with a single table, the Data Protection key ring of its session cookie, in `gateway`. A migration runner applies the four contexts of the Starter in a fixed order before the hosts start ([a migration runner](/blog/2026-09-01-a-migration-runner-instead-of-migrate-at-startup/)).


## The tools need to be told which context
With more than one context in a startup project, `dotnet ef` refuses to guess, and every command needs `-c`. `-p` decides where the migration files go, so the billing migrations stay in the billing project:

```bash
dotnet ef migrations add Add_Plan_AllowsSso \
  -s back/Blouppy.Web -p back/Blouppy.Billing \
  -c BillingDbContext -o Infrastructure/Database/Migrations
```

An [`IDesignTimeDbContextFactory<T>`](https://learn.microsoft.com/ef/core/cli/dbcontext-creation#from-a-design-time-factory) in the module saves the tools from booting the whole host. One trap: the history table's schema is now written in several places, the registration, the factory and the runner. A factory that forgets `MigrationsHistoryTable` generates the same files, but `database update` records them in another table and tries to apply them again.


## No foreign key, no join
A foreign key is part of a model, and a model belongs to one context. A billing subscription has an `OrganizationId`, but organizations live in the application's context. So the billing migration creates a plain integer column, with no constraint.

PostgreSQL would accept a constraint across schemas, added by hand. We do not add one, because it would tie the two migration histories together again. The consequences:

- **Nothing cascades.** Deleting an organization leaves its subscription. Billing listens for `OrganizationDeletedIntegrationEvent` and cancels it. An account erasure works the same way, through `AccountErasedIntegrationEvent` ([GDPR data export and account erasure](/blog/2026-10-07-gdpr-data-export-and-account-erasure/)).
- **No LINQ join across contexts.** A query that needs both becomes two queries, or a projection kept up to date by events.
- **Orphans are possible** until the event is handled, so every handler must cope with a row that is already gone.


## One transaction across two contexts
Sometimes the module's rows and the application's rows must commit together. In the Starter, they must. A subscription change publishes integration events, and Wolverine's outbox is mapped in the application's context only. Two `SaveChanges` in two transactions could commit the subscription without its message.

Two contexts can share a transaction only if they share a connection. Billing's unit of work borrows the application's:

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

The application's `UnitOfWork` opens the transaction inside the [execution strategy](https://learn.microsoft.com/ef/core/miscellaneous/connection-resiliency#execution-strategies-and-transactions). It lets billing save first, then saves its own context, outbox rows included, and commits.

Two details carry the weight. `contextOwnsConnection: false` means billing uses the connection without closing it. `acceptAllChangesOnSuccess: false` means that if the strategy retries the whole block, the billing changes are still tracked and saved again. All of this works only because both contexts point at the **same database**. A second database would need a distributed transaction.


## When one context is better
The main benefit of a separate schema is that the module can be dropped, or moved to its own database, with nothing else to migrate. If the "module" constantly joins the core tables, needs foreign keys into them or writes alongside them in most use cases, it is part of the core model. Splitting it only replaces SQL guarantees with event handlers. One context with a few schemas (`ToTable("plans", "billing")`) and [architecture tests](/blog/2026-07-03-architecture-tests-that-fail-the-build/) keeps the organization without the second context.

A separate host is the opposite case. The gateway has its own process and a single table. Sharing the application's context would mean referencing the whole application model from it.


## References
- [Migrations history table (Microsoft Learn)](https://learn.microsoft.com/ef/core/managing-schemas/migrations/history-table) — `MigrationsHistoryTable` and its schema.
- [Design-time DbContext creation (Microsoft Learn)](https://learn.microsoft.com/ef/core/cli/dbcontext-creation) — how the tools find a context.
- [Using transactions (Microsoft Learn)](https://learn.microsoft.com/ef/core/saving/transactions#share-connection-and-transaction) — sharing a connection and a transaction between contexts.
- [The billing module](/blog/2026-10-01-billing-module-behind-an-adapter/) — why billing is a module, and how Stripe stays behind a port.
