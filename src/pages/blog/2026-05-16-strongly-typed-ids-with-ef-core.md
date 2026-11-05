---
templateKey: 'blog-post'
title: 'Strongly typed IDs in C# with EF Core and PostgreSQL'
date: 2026-05-16T09:00:00.000Z
author: Jimmy Boinembalome
authorimage: /img/jimmy.jpg
category: C#
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

Here is a method signature most of us have written: `Task AddTeamAsync(int workspaceId, int organizationId)`. Swap the two arguments at the call site and the compiler is perfectly happy. The bug shows up later, as a team attached to the wrong workspace, or as a permission check that passes for the wrong organization.

**Strongly typed IDs** fix this: a `WorkspaceId` is not an `OrganizationId`, so the mistake no longer compiles. The idea is simple. Wiring it into EF Core, into the database's key generation and into an HTTP API is where people get stuck.

In this article, we will build a small base type for our IDs, map every one of them in EF Core with a single convention, give them HiLo sequences on PostgreSQL, and decide where they stop at the API boundary.


## A base record for every ID
Let's start with the base type. A C# `record` gives us value equality for free: two `TeamId(3)` are equal, which is exactly what an identifier needs.

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
```

And here is what an ID looks like once the base exists:

```csharp
public sealed record TeamId(
    int Value) : IntStrongType(Value);

public sealed record WorkspaceId(
    int Value) : IntStrongType(Value);
```

A few things are worth explaining:
- `IntStrongType` and a sibling `StringStrongType` fix the native type, so the rest of the code can tell an int ID from a string ID by its base class.
- A record's default `ToString()` prints `TeamId { Value = 3 }`. The `sealed` override makes a log message or an interpolated string show `3`.
- Each ID is a one-line `sealed record`, so there is no excuse to reuse `int`.

Now `AddTeamAsync(WorkspaceId workspaceId, OrganizationId organizationId)` refuses swapped arguments at compile time. 👍

Entities take the ID as their key through a generic base class, `EntityBase<TId>`, with a `public TId Id { get; set; }`. A `Team` is a `CreatedAtEntityBase<TeamId>` (a subclass of it), and its foreign key is a `WorkspaceId`, not an `int`. Its constructor even guards it like any other argument, `WorkspaceId = Exceptions.ThrowIfNullOrNegativeOrZero(workspaceId);`, through an overload constrained to `IntStrongType`.


## One value converter for every ID
EF Core does not know what a `TeamId` is. It needs a **value converter** that turns it into an `int` on the way to the database and back. Writing one per ID would be tedious, so let's write a single generic one:

```csharp
internal sealed class IntStrongIdValueConverter<TStrongId>()
    : ValueConverter<TStrongId, int>(
        id => id.Value,
        value => (TStrongId)Activator.CreateInstance(typeof(TStrongId), value)!)
    where TStrongId : IntStrongType;
```

The way back has no common constructor to call, so it uses `Activator.CreateInstance` with the ID's single `int` parameter. A `StringStrongIdValueConverter<TStrongId>` does the same for string IDs.

Then, instead of configuring each property by hand, let's scan the assembly where the IDs live and register a converter for each one:

```csharp
public static ModelConfigurationBuilder ApplyStrongTypeConvertersFromAssembly(
    this ModelConfigurationBuilder modelConfigurationBuilder,
    Assembly assembly)
{
    var strongTypes = assembly.DefinedTypes
        .Where(x => x.IsStrongType() && x.IsClass)
        .ToArray();

    foreach (var type in strongTypes)
    {
        var baseStrongType = type.BaseType;

        if (baseStrongType == typeof(IntStrongType))
        {
            modelConfigurationBuilder.ApplyConversion(type, typeof(IntStrongIdValueConverter<>));
        }
        else if (baseStrongType == typeof(StringStrongType))
        {
            modelConfigurationBuilder.ApplyConversion(type, typeof(StringStrongIdValueConverter<>));
        }
    }

    return modelConfigurationBuilder;
}
```

`ApplyConversion` closes the generic converter over the ID type and calls `Properties(type).HaveConversion(converterType)`. This is EF Core's **pre-convention configuration**: it applies to every property of that type in the model, keys and foreign keys alike.

The `DbContext` calls it from `ConfigureConventions`:

```csharp
protected override void ConfigureConventions(ModelConfigurationBuilder configurationBuilder)
{
    var assembly = typeof(OrganizationId).Assembly;

    configurationBuilder.ApplyStrongTypeConvertersFromAssembly(assembly);

    base.ConfigureConventions(configurationBuilder);
}
```

From now on, adding an ID is adding the record. No converter to write, no line to remember in any entity configuration. 🙂

## Who assigns the key? HiLo sequences
Here is the trap. With a plain `int` key, PostgreSQL generates the value (an identity column) and EF Core reads it back. Once the key goes through a value converter, EF Core no longer sets it up as generated by default, and nothing assigns the key at all.

We could configure an identity column explicitly. Instead, let's use **HiLo**: EF Core reserves a block of IDs from a PostgreSQL sequence in one round trip, then hands them out on the client. The ID is known as soon as the entity is added, before `SaveChanges`, and inserting fifty rows does not cost fifty sequence calls.

Let's write a helper that creates one sequence per table:

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

`UseHiLo` comes from the Npgsql EF Core provider; the `EntityBase<TId>` constraint lets us write `x => x.Id` generically.

The sequence is declared next to the entity's configuration, through a small `IModelConfiguration` interface (`void ConfigureModel(ModelBuilder modelBuilder)`) that an `ApplyModelConfigurationsFromAssembly` extension finds by reflection, the same way `ApplyConfigurationsFromAssembly` finds the `IEntityTypeConfiguration<T>` classes. Here is the teams table, trimmed:

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

And the migration EF Core generates from it:

```csharp
migrationBuilder.CreateSequence(
    name: "teams_hilo_sequence",
    schema: "blouppy",
    incrementBy: 50);
```

The increment is chosen per table by insert rate: `1` for rare rows (organizations, invitations), `5` for workspaces, `50` for bursts (teams, notifications). A large block saves round trips, but the unused part of it becomes a gap in the IDs when the application restarts.

> **_Note:_**  Not every key comes from a sequence. A `UserId` is a string minted by the identity server, and some rows are keyed on another entity's ID. Those keys are configured with `.ValueGeneratedNever()` instead.


## Comparing IDs inside a query
An ID used as a keyset pagination tiebreaker has to appear in a `WHERE` clause as `id > @cursor`. Reading `x.Id.Value` in a LINQ expression does not work: the property is stored through a converter, so the column is all the provider can see, and there is nothing to translate `.Value` to.

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

With them (plus `<=` and `>=`), the pagination code can build `Expression.GreaterThan(propertyAccess, constant)` on a `TeamId`, and EF Core translates it as a comparison of the column.


## Routing and JSON: stop at the edge
People expect this part to be the hardest: a model binder, a `JsonConverter`, an OpenAPI schema fix. The code base this comes from takes the simplest road: **the typed IDs never leave the server**. Routes and DTOs keep `int`, and the controller wraps it on the first line.

```csharp
[Route("api/v{version:apiVersion}/workspaces/{workspaceId:int}/[controller]")]
public class TeamsController(/* ... */) : ControllerBase
{
    [HttpGet(Name = RouteNames.Api.Workspaces.Teams.Get)]
    public async Task<ActionResult<TeamDto>> GetAsync(
        int workspaceId,
        CancellationToken cancellationToken)
    {
        var typedWorkspaceId = new WorkspaceId(workspaceId);

        if (!await workspacesApiQueryService.ExistsAsync(typedWorkspaceId, cancellationToken))
        {
            return NotFound($"Workspace ({workspaceId}) not found.");
        }

        // ...
    }
}
```

Bodies follow the same rule. The DTO is plain:

```csharp
public sealed record TeamEditionDto(
    int Id,
    string Name,
    IReadOnlyCollection<string> MemberIds,
    int WorkspaceId);
```

And a mapper does the wrapping and unwrapping, in one place:

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

Why not serialize the IDs directly? Without a custom converter, System.Text.Json writes a record as an object, `{ "value": 42 }` instead of `42`. A `JsonConverter`, a model binder and an OpenAPI schema mapping would fix that, but each is one more piece to keep in sync, and the Angular client gains nothing: in TypeScript, an ID is a `number` either way. The cost is one explicit `new WorkspaceId(...)` per action.

> **_Note:_**  The `{workspaceId:int}` route constraint still matters: a non-numeric segment never reaches the action, so the wrapping can never fail on bad input. 😉


## Parsing an ID back from a string
There is one place where an ID does travel as text: a pagination cursor, which is an opaque, base64-encoded string the client hands back. Decoding it means building a `WorkspaceId` from `"42"` without knowing the type at compile time.

Two helpers make that generic. `TryGetStrongIdNativeType`, an extension on `Type`, walks the base classes until it meets `StrongType<>` and returns its generic argument. `StrongType.Parse<TStrongType>(input, nativeType)` then converts the string with `Convert.ChangeType` under the invariant culture and invokes the ID's single-parameter constructor. Its tests check that `WorkspaceId` resolves to `int`, `UserId` to `string`, and that `string` is not an ID. The first helper once read the wrong generic argument and threw for every strong ID, unnoticed until a cursor was first decoded into one: reflection code deserves its own tests.


## Conclusion
Strongly typed IDs turn a whole category of bugs into compile errors. A one-line `sealed record` per ID, on top of a small `StrongType<T>` base with value equality, a clean `ToString()` and ordering operators, is all the domain needs.

On the database side, one generic value converter registered by convention in `ConfigureConventions` maps every ID at once, and HiLo sequences on PostgreSQL answer the question converted keys raise: who assigns the value. At the HTTP edge, keeping `int` in routes and DTOs and wrapping it in the controller avoids JSON converters and model binders entirely.

This is how every entity key is built in [Blouppy Starter](https://starter.blouppy.com/), from `WorkspaceId` and `TeamId` to the billing module's own IDs. The [reads and writes page](https://docs.starter.blouppy.com/architecture/reads-and-writes/) shows where the controllers sit between the two verticals that use them.

*Thanks for reading! 🙂*
