---
templateKey: 'blog-post'
title: 'Strongly typed IDs in C# with EF Core and PostgreSQL'
date: 2026-05-16T09:00:00.000Z
updated: 2026-11-07T09:00:00.000Z
author: Jimmy Boinembalome
authorimage: /img/jimmy.jpg
category: C#
topic: 'Data'
illustration: 1
categorycolor: bg-purple-100 text-purple-800
featuredpost: true
featuredimage: /img/strongly-typed-ids-with-ef-core.jpg
description: >-
  Learn how to replace primitive int keys with strongly typed IDs in C#, and wire them into EF Core, HiLo sequences on PostgreSQL and your API controllers.
tags:
  - Development
  - C#
  - EF Core
  - PostgreSQL
  - ASP.NET Core
---

Most of us have written this signature: `Task AddTeamAsync(int workspaceId, int organizationId)`. Swap the two arguments at the call site and the compiler is happy. The bug shows up later, as a team attached to the wrong workspace or a permission check that passes for the wrong organization.

**Strongly typed IDs** fix this: a `WorkspaceId` is not an `OrganizationId`, so the mistake no longer compiles. The idea is simple; wiring it into EF Core, the database's key generation and an HTTP API is where people get stuck.

In this article, we build a small base type for our IDs, map all of them in EF Core with one convention, give them HiLo sequences on PostgreSQL and decide where they stop at the API boundary.


## A base record for every ID
A C# [`record`](https://learn.microsoft.com/dotnet/csharp/language-reference/builtin-types/record) gives value equality for free: two `TeamId(3)` are equal, which is what an identifier needs.

```csharp
public abstract record StrongType<TNativeType>(
    TNativeType Value)
    : IComparable<StrongType<TNativeType>>
    where TNativeType : notnull
{
    public TNativeType Value { get; } = Value;

    public int CompareTo(StrongType<TNativeType>? other)
        => other is null
            ? 1
            : Comparer<TNativeType>.Default.Compare(Value, other.Value);
}

public abstract record IntStrongType(
    int Value) : StrongType<int>(Value)
{
    public sealed override string ToString()
        => Value.ToString(CultureInfo.InvariantCulture);
}

public sealed record TeamId(
    int Value) : IntStrongType(Value);
```

- `IntStrongType` and its sibling `StringStrongType` fix the native type, so the rest of the code can tell an int ID from a string ID by its base class.
- A record's default `ToString()` prints `TeamId { Value = 3 }`; the `sealed` override makes logs show `3`.

Entities take the ID as their key through a generic base class, `EntityBase<TId>`. A `Team` is a `CreatedAtEntityBase<TeamId>`, and its foreign key is a `WorkspaceId`, which its constructor guards like any other argument: `WorkspaceId = Exceptions.ThrowIfNullOrNegativeOrZero(workspaceId);`.


## One value converter for every ID
EF Core does not know what a `TeamId` is. It needs a [value converter](https://learn.microsoft.com/ef/core/modeling/value-conversions) that turns it into an `int` on the way to the database and back. One generic converter covers every int ID:

```csharp
internal sealed class IntStrongIdValueConverter<TStrongId>()
    : ValueConverter<TStrongId, int>(
        id => id.Value,
        value => (TStrongId)Activator.CreateInstance(typeof(TStrongId), value)!)
    where TStrongId : IntStrongType;
```

The way back has no common constructor to call, so it uses `Activator.CreateInstance` with the ID's single `int` parameter. A `StringStrongIdValueConverter<TStrongId>` does the same for string IDs.

Instead of configuring each property by hand, an `ApplyStrongTypeConvertersFromAssembly` extension scans the assembly where the IDs live and, for each type deriving from `IntStrongType` or `StringStrongType`, calls `Properties(type).HaveConversion(...)` with the matching converter closed over that type. This is EF Core's [pre-convention configuration](https://learn.microsoft.com/ef/core/modeling/bulk-configuration#pre-convention-configuration): it applies to every property of that type, keys and foreign keys alike. The `DbContext` calls it from `ConfigureConventions`:

```csharp
protected override void ConfigureConventions(ModelConfigurationBuilder configurationBuilder)
{
    var assembly = typeof(OrganizationId).Assembly;

    configurationBuilder.ApplyStrongTypeConvertersFromAssembly(assembly);

    base.ConfigureConventions(configurationBuilder);
}
```

From now on, adding an ID means adding the record: no converter to write, no line to remember in an entity configuration.


## Who assigns the key? HiLo sequences
Here is the trap. With a plain `int` key, PostgreSQL generates the value (an identity column) and EF Core reads it back. Once the key goes through a value converter, EF Core no longer configures it as [generated](https://learn.microsoft.com/ef/core/modeling/generated-properties): in a scratch model, a `TeamId` key with the converter above comes out as `ValueGenerated.Never`, so nothing assigns it.

We could configure an identity column explicitly. Instead, we use **HiLo**: EF Core reserves a block of IDs from a PostgreSQL [sequence](https://learn.microsoft.com/ef/core/modeling/sequences) in one round trip, then hands them out on the client. The ID is known as soon as the entity is added, before `SaveChanges`, and inserting fifty rows does not cost fifty sequence calls. A helper creates one sequence per table:

```csharp
public static void UseSequence<TEntity, TId>(
    this ModelBuilder modelBuilder,
    int increment = 100)
    where TEntity : EntityBase<TId>
    where TId : notnull
{
    var entityBuilder = modelBuilder.Entity<TEntity>();

    var schema = entityBuilder.Metadata.GetSchema();
    var tableName = entityBuilder.Metadata.GetTableName();
    var sequenceName = $"{tableName}_hilo_sequence";

    modelBuilder
        .HasSequence(sequenceName, schema)
        .IncrementsBy(increment);

    entityBuilder
        .Property(x => x.Id)
        .UseHiLo(sequenceName, schema);
}
```

[`UseHiLo`](https://www.npgsql.org/efcore/modeling/generated-properties.html) comes from the Npgsql EF Core provider; the `EntityBase<TId>` constraint lets us write `x => x.Id` generically.

The sequence is declared next to the entity's configuration, through a small `IModelConfiguration` interface (`void ConfigureModel(ModelBuilder modelBuilder)`) that an `ApplyModelConfigurationsFromAssembly` extension finds by reflection, the way `ApplyConfigurationsFromAssembly` finds `IEntityTypeConfiguration<T>` classes. Here is the teams table, trimmed:

```csharp
internal sealed class TeamConfiguration : CreatedAtEntityTypeConfiguration<Team, TeamId>, IModelConfiguration
{
    protected override void ConfigureEntity(EntityTypeBuilder<Team> builder)
    {
        builder.ToTable("teams");

        builder
            .HasKey(x => x.Id);

        builder
            .HasOne<Workspace>()
            .WithOne()
            .HasForeignKey<Team>(x => x.WorkspaceId);
    }

    public void ConfigureModel(ModelBuilder modelBuilder)
    {
        modelBuilder.UseSequence<Team, TeamId>(increment: 50);
    }
}
```

The migration then contains `migrationBuilder.CreateSequence(name: "teams_hilo_sequence", schema: "blouppy", incrementBy: 50)`.

Pick the increment per table by insert rate: `1` for rare rows (organizations, invitations), `5` for workspaces, `50` for bursts (teams, notifications). A large block saves round trips, but its unused part becomes a gap in the IDs when the application restarts.

> **_Note:_** Not every key comes from a sequence. A `UserId` is a string minted by the identity server, and some rows are keyed on another entity's ID. Those keys use `.ValueGeneratedNever()`.


## Comparing IDs inside a query
An ID used as a [keyset pagination](https://learn.microsoft.com/ef/core/querying/pagination#keyset-pagination) tiebreaker must appear in a `WHERE` clause as `id > @cursor`. Reading `x.Id.Value` in a LINQ expression does not work: the property is stored through a converter, so the provider only sees the column and cannot translate `.Value`.

The fix is to give `IntStrongType` its own ordering operators, so the expression compares the IDs themselves:

```csharp
public static bool operator <(IntStrongType? left, IntStrongType? right)
    => Compare(left, right) < 0;

public static bool operator >(IntStrongType? left, IntStrongType? right)
    => Compare(left, right) > 0;

private static int Compare(IntStrongType? left, IntStrongType? right)
    => left is null
        ? right is null ? 0 : -1
        : left.CompareTo(right);
```

With them (plus `<=` and `>=`), the pagination code can build `Expression.GreaterThan(propertyAccess, constant)` on a `TeamId`. EF Core translates `t => t.Id > new TeamId(10)` to `WHERE t."Id" > 10`.


## Routing and JSON: stop at the edge
You might expect this part to be the hardest: a model binder, a `JsonConverter`, an OpenAPI schema fix. The simplest road is to **keep typed IDs inside the server**. Routes and DTOs keep `int`, and the controller wraps the value on its first line:

```csharp
[HttpGet(Name = RouteNames.Api.Workspaces.Teams.Get)] // route: workspaces/{workspaceId:int}/teams
public async Task<ActionResult<TeamDto>> GetAsync(int workspaceId, CancellationToken cancellationToken)
{
    var typedWorkspaceId = new WorkspaceId(workspaceId);

    if (!await workspacesApiQueryService.ExistsAsync(typedWorkspaceId, cancellationToken))
    {
        return NotFound($"Workspace ({workspaceId}) not found.");
    }

    // ...
}
```

Bodies follow the same rule. `TeamEditionDto` is a plain record (`int Id`, `string Name`, `IReadOnlyCollection<string> MemberIds`, `int WorkspaceId`), and a mapper does the wrapping in one place:

```csharp
public static TeamEdition MapToEdition(TeamEditionDto editionDto)
    => new(
        Id: new TeamId(editionDto.Id),
        Name: editionDto.Name,
        MemberIds: editionDto.MemberIds
            .Select(x => new UserId(x))
            .ToArray(),
        WorkspaceId: new WorkspaceId(editionDto.WorkspaceId));
```

Why not serialize the IDs directly? Without a [custom converter](https://learn.microsoft.com/dotnet/standard/serialization/system-text-json/converters-how-to), System.Text.Json writes a record as `{ "value": 42 }`. A `JsonConverter`, a model binder and an OpenAPI schema mapping would fix that, but each is one more piece to keep in sync, and the Angular client gains nothing: in TypeScript an ID is a `number` either way. The cost is one `new WorkspaceId(...)` per action.

> **_Note:_** The `{workspaceId:int}` [route constraint](https://learn.microsoft.com/aspnet/core/fundamentals/routing#route-constraints) still matters: a non-numeric segment never reaches the action, so the wrapping never fails on bad input.


## Parsing an ID back from a string
A pagination cursor is an opaque, base64-encoded string the client hands back, so decoding it means building a `WorkspaceId` from `"42"` without knowing the type at compile time. `TryGetStrongIdNativeType` walks a type's base classes to `StrongType<>` and returns its generic argument; `StrongType.Parse<TStrongType>(input, nativeType)` converts the string with `Convert.ChangeType` under the invariant culture and invokes the single-parameter constructor. Test such reflection code on its own: the first helper once read the wrong generic argument and threw for every strong ID, unnoticed until a cursor was first decoded into one.


## Conclusion
Strongly typed IDs turn a category of bugs into compile errors. A one-line `sealed record` per ID on a small base is all the domain needs. One generic value converter registered in `ConfigureConventions` maps every ID, HiLo sequences decide who assigns the value, and keeping `int` at the HTTP edge avoids JSON converters and model binders.

Every entity key in [Blouppy Starter](https://starter.blouppy.com/) is built this way, from `WorkspaceId` and `TeamId` to the billing module's own IDs.


## References

- [Value conversions](https://learn.microsoft.com/ef/core/modeling/value-conversions) — EF Core documentation: converters, including on keys.
- [Model bulk configuration](https://learn.microsoft.com/ef/core/modeling/bulk-configuration#pre-convention-configuration) — EF Core documentation: `ConfigureConventions` and `HaveConversion`.
- [Generated values](https://learn.microsoft.com/ef/core/modeling/generated-properties) and [Sequences](https://learn.microsoft.com/ef/core/modeling/sequences) — EF Core documentation: who assigns a key.
- [Npgsql: generated properties](https://www.npgsql.org/efcore/modeling/generated-properties.html) — identity columns and HiLo on PostgreSQL.
- [Pagination](https://learn.microsoft.com/ef/core/querying/pagination#keyset-pagination) — EF Core documentation: keyset pagination.
- [Records](https://learn.microsoft.com/dotnet/csharp/language-reference/builtin-types/record) — C# reference: value equality and `ToString()`.
- [Custom converters for System.Text.Json](https://learn.microsoft.com/dotnet/standard/serialization/system-text-json/converters-how-to) — what serializing the IDs directly would take.
- [Route constraints](https://learn.microsoft.com/aspnet/core/fundamentals/routing#route-constraints) — ASP.NET Core routing: `{id:int}`.
- [Reads and writes in Blouppy Starter](https://docs.starter.blouppy.com/architecture/reads-and-writes/) — where the controllers that wrap the IDs sit.
