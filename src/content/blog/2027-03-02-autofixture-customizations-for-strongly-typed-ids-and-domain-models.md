---
templateKey: 'blog-post'
title: 'AutoFixture in a DDD code base: customizations for strongly typed IDs and domain models'
date: 2027-03-02T09:00:00.000Z
author: Jimmy Boinembalome
authorimage: /img/jimmy.jpg
category: C#
topic: 'Testing'
illustration: 1
categorycolor: bg-purple-100 text-purple-800
featuredpost: true
description: >-
  Learn where AutoFixture helps and where it fights a domain model in C#, and how ICustomization and ISpecimenBuilder make it build strongly typed IDs and value objects that hold.
tags:
  - Development
  - C#
  - Testing
  - xUnit
---

A test needs a workspace. The workspace needs a name, a colour, an owner and an organization, and none of them matter to the test. Written by hand, the arrange step grows four lines of values nobody reads. [AutoFixture](https://autofixture.github.io/) removes them: `fixture.Create<Workspace>()` and the test says only what it is about.

Then the domain model pushes back. A constructor guards an invariant, a property has a private setter, an ID wraps a string that the database limits to 36 characters, a value object refuses two currencies. AutoFixture knows none of these rules, and the test fails before it reaches the code under test.

In this article, we will look at what AutoFixture does well, where it meets a DDD model, how `ICustomization`, `ISpecimenBuilder`, `Build<T>()` and friends teach it the rules, and when a plain constructor reads better. The examples come from [Blouppy Starter](https://starter.blouppy.com/).


## What AutoFixture does well
AutoFixture builds **anonymous data**: values whose content does not matter, only that they exist and are valid for their type. It picks a public constructor, creates an argument for each parameter, then fills the public writable properties.

```csharp
var fixture = new Fixture();

var name = fixture.Create<string>();
var ids = fixture.CreateMany<OrderId>().ToArray();
var order = fixture.Create<Order>();
```

Two things make this useful beyond saving keystrokes. The arrange step shrinks to the values the test cares about, so a reader sees at once what drives the result. And the data is not a constant: a test that only passes because the name is `"test"` or the ID is `1` stops passing.

With strongly typed IDs, AutoFixture already does the right thing most of the time. A `sealed record TeamId(int Value) : IntStrongType(Value)` has one constructor taking an `int`, AutoFixture generates small positive integers, and the ID passes a `ThrowIfNullOrNegativeOrZero` guard. That is why the Starter's `TeamTests` builds a team with no customization at all:

```csharp
private readonly IFixture _fixture = new Fixture();

private Team Given_a_Team_on_creation()
    => new(
        name: _fixture.Create<string>(),
        workspaceId: _fixture.Create<WorkspaceId>(),
        memberIds: _fixture.CreateMany<UserId>().ToArray());
```

The constructor is called by hand, its arguments come from the fixture. We will come back to that pattern.


## Where it fights a domain model
A domain model is built to refuse bad states, and AutoFixture fills things in without knowing which states are bad. Four places show it.

**Private setters.** AutoFixture fills public writable properties only. `Workspace` exposes `OrganizationId { get; private set; }`, so a created workspace keeps the random organization its constructor received, and no `With(...)` can change it.

**Constructors with invariants.** A constructor that checks a relation between two arguments (an end after a start, two amounts in the same currency) receives random values for each and throws.

**Strongly typed IDs on a real database.** For a `string` parameter named `value`, AutoFixture generates the parameter name followed by a GUID. A `UserId` built that way is 41 characters long, and the Starter maps every `UserId` column with `HasMaxLength(36)`. In memory nothing complains; PostgreSQL refuses the insert.

**Value objects.** A record's positional properties have `init` accessors, which AutoFixture treats as writable. It constructs the object through its constructor, guard included, then overwrites the properties after the fact.

The fix for all four is to tell AutoFixture how to build those types, once, in a place every test shares.


## Customizations: Register, Customize and ISpecimenBuilder
AutoFixture offers three levels, from the simplest to the most general. `Register` replaces the construction of a type with a function:

```csharp
fixture.Register((int days) => new DateRange(Today, Today.AddDays(Math.Abs(days) + 1)));
```

`Customize<T>` does the same with more control, through a composer: `FromFactory` builds the instance, `OmitAutoProperties` stops the property filling, `With` and `Without` set or skip one member. And an `ICustomization` groups any of these behind a name, so a fixture applies it in one line.

The Starter's `AmountCustomization`, in `Blouppy.Shared.TestHelpers`, uses all three ideas. `Amount` is a record of a value and a currency, and a plan holding a monthly and an annual amount checks that both share one currency. AutoFixture picks each enum value independently, so it would build two amounts in different currencies:

```csharp
public sealed class AmountCustomization : ICustomization
{
    private static readonly Currency FixedCurrency = Currency.Usd;

    public void Customize(IFixture fixture)
        => fixture.Customize<Amount>(composer =>
            composer
                .FromFactory((decimal value) => new Amount(Math.Abs(value), FixedCurrency))
                .OmitAutoProperties());
}
```

`FromFactory` asks the fixture for a `decimal` and builds the amount through its real constructor, so the non-negative guard still runs. `OmitAutoProperties` is the line that is easy to forget: without it, AutoFixture sets the `init`-only `Currency` again after construction and the fixed currency is lost. `DateOnlyCustomization` is the same shape, building a `DateOnly` from a generated `DateTime`.

When the rule is about a kind of request rather than one type, `ISpecimenBuilder` is the general tool. AutoFixture asks each builder in turn; a builder returns a specimen, or `NoSpecimen` to say "not mine". Here is how the database tests build a `UserId` that fits its column:

```csharp
public sealed class UserIdCustomization : ICustomization
{
    public void Customize(IFixture fixture)
        => fixture.Customizations.Add(new UserIdSpecimenBuilder());
}

internal sealed class UserIdSpecimenBuilder : ISpecimenBuilder
{
    public object Create(object request, ISpecimenContext context)
    {
        if (request is not Type type || type != typeof(UserId))
        {
            return new NoSpecimen();
        }

        return new UserId(context.Create<Guid>().ToString());
    }
}
```

A bare GUID string is 36 characters, and the builder still asks the context for the GUID, so the value stays anonymous. The project-management app built on the Starter adds a builder of the same shape for its issue codes, `new Code($"BLO-{context.Create<int>()}")`, because a code has a format the domain checks.

A builder can also match properties. `PropertyNameOmitterSpecimenBuilder` returns `OmitSpecimen` for a `PropertyInfo` whose name is in its list (`Id`, `CreatedBy`, `CreatedDate` and the two modification columns), so the HiLo sequence assigns the key and the interceptors fill the audit columns, as in production. `MicrosecondDateTimeOffsetCustomization` answers every `DateTimeOffset` request, whether a type, a property or a parameter, with the current instant truncated to the microsecond, the precision PostgreSQL stores. The [Testcontainers article](/blog/2026-07-15-testing-ef-core-repositories-with-testcontainers/) explains why those two matter on a real database.


## One fixture per test project
Customizations are only useful if every test gets them. The Starter derives a `Fixture` per test project and applies them in the constructor. The database tests use this one:

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

The Web's unit tests have their own, `ApiFixture`, with `DateOnlyCustomization`, `AmountCustomization` and a builder that gives every sort query a valid `"id:asc"`. Each fixture carries only what its project needs: the database rules (column lengths, microseconds, generated keys) stay out of the domain's unit tests, which run on a plain `new Fixture()`.


## Build, With and Without for one test
A customization is for every test; `Build<T>()` is for one. It returns a composer for a single creation:

```csharp
var filter = Builder.Build<WorkspaceQueryFilter>()
    .With(x => x.UserId, () => userId1)
    .Without(x => x.OrganizationId)
    .With(x => x.Sort, () => [])
    .Create();
```

This is a test of the workspaces read repository. It pins the user it filters on, leaves the organization `null` so that the filter does not narrow further, and empties the sort. Everything else stays anonymous. A reader sees the three values that decide the result.

`With` only reaches what AutoFixture could set anyway. For a private setter, the Starter's tests use a small reflection helper, `SetProperty`, after creating the entity:

```csharp
public async Task<Workspace> Given_a_Workspace(OrganizationId organizationId)
{
    var workspace = builder.Create<Workspace>();
    workspace.SetProperty(x => x.OrganizationId, organizationId);

    await arrangeDbContext.Workspaces.AddAsync(workspace);
    await arrangeDbContext.SaveChangesAsync();

    return workspace;
}
```

This is a trade. The workspace's own methods never move it to another organization, and the helper does it anyway, in a test's arrange step only. It keeps the model's setters private for production code at the cost of a helper that bypasses them; we keep it to the `Given_a_*()` helpers and to IDs.

The Starter does not use `AutoMoqCustomization`. Its tests create mocks with `Mock.Of<T>()` and pass them to the constructor of the class under test, so every dependency is named in the test class. AutoMoq would build the class and its mocks in one call, which is shorter and hides the same list.


## The pitfalls
**Random data hides the case under test.** A test that checks an update changes a workspace's colour passes only if the new colour differs from the old one. With AutoFixture generating both, it depends on the order the enum values come out. When a value matters to the assertion, set it explicitly.

**Tests that pass by luck.** The opposite case: say a validator rejects names over 100 characters; the generated name is a GUID with a prefix, and the "valid name" test passes without anyone having chosen a valid name. It keeps passing until the limit changes. A boundary is written by hand, in an `[InlineData]`, never left to the generator.

**Recursion.** An entity graph with a back-reference (a parent holding children that point at the parent) makes AutoFixture throw by default. Swapping the behavior makes it stop at the cycle instead:

```csharp
fixture.Behaviors.OfType<ThrowingRecursionBehavior>().ToList()
    .ForEach(behavior => fixture.Behaviors.Remove(behavior));
fixture.Behaviors.Add(new OmitOnRecursionBehavior());
```

This is quick, and often a sign the test is creating a graph it does not need. Creating the child alone, with its parent's ID, is usually clearer.

**Slow fixtures.** AutoFixture builds the whole object graph by reflection. For a flat input record it does not matter; for a type with dozens of properties and nested collections, the cost shows across a large suite. `Build<T>().OmitAutoProperties()` or a narrower type keeps it in check.

**Customizations that drift from the model.** `AmountCustomization` encodes a rule of `Plan`. If the rule changes, the customization still builds the old shape and the tests keep passing on data the model would now refuse. A customization should go through the real constructor, as `FromFactory` does here, so the guards keep running.


## When a plain constructor reads better
For a domain model's own tests, calling the constructor by hand is often the clearest option. `TeamTests` does exactly that: the arguments come from the fixture, but the constructor call shows which arguments a team needs, and a new parameter breaks the test at compile time rather than being filled in silently.

An explicit builder (`new WorkspaceBuilder().InOrganization(id).Build()`) earns its place when a few tests need the same meaningful state, such as a team with a given member list or a subscription that has expired. Its methods name the state; a chain of `With` calls only lists values.

AutoFixture is the better choice for the rest: input records passed through a service, entities that only need to exist, DTOs mapped by the Web. That is most of the arrange code in a service test, and it is where removing noise pays.


## Conclusion
AutoFixture is good at the data a test does not care about, and a domain model is full of rules about data. A handful of customizations, each going through the real constructor, reconciles the two: strongly typed IDs that fit their column, value objects that keep their invariant, generated keys and audit columns left to the database. Keep them in one fixture per test project, use `Build<T>()` for what one test pins, and write by hand every value an assertion depends on.

Strongly typed IDs themselves, and how they map to EF Core, are covered in [Strongly typed IDs in C# with EF Core and PostgreSQL](/blog/2026-05-16-strongly-typed-ids-with-ef-core/). The customizations shown here are those of [Blouppy Starter](https://starter.blouppy.com/).


## References
- [AutoFixture](https://autofixture.github.io/) — the project's documentation and cheat sheet.
- [AutoFixture on GitHub](https://github.com/AutoFixture/AutoFixture) — source, issues and the wiki on customizations and specimen builders.
- [AutoFixture on NuGet](https://www.nuget.org/packages/AutoFixture) — the package, version 4.18.1 in the Starter.
- [AutoFixture.AutoMoq on NuGet](https://www.nuget.org/packages/AutoFixture.AutoMoq) — `AutoMoqCustomization`, for building mocks through the fixture.
- [Init-only setters](https://learn.microsoft.com/dotnet/csharp/language-reference/keywords/init) (Microsoft Learn) — why a record's positional properties are writable through reflection.
- [Records](https://learn.microsoft.com/dotnet/csharp/language-reference/builtin-types/record) (Microsoft Learn) — positional records and their generated properties.
- [xUnit.net](https://xunit.net/) — the test framework the examples run on.
