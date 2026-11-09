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

A test needs a workspace. The workspace needs a name, a colour, an owner and an organization, and none of them matter to the test. Written by hand, the arrange step grows four lines of values nobody reads. [AutoFixture](https://autofixture.github.io/) removes them: `fixture.Create<Workspace>()`, and the test says only what it is about.

Then the domain model pushes back. A constructor guards an invariant, an ID must fit a column, a value object refuses two currencies. AutoFixture knows none of these rules, and the test fails before it reaches the code under test.


## Anonymous data
AutoFixture builds values whose content does not matter, only that they exist and are valid for their type. It picks a public constructor, creates an argument for each parameter, then fills the public writable properties.

Two things make this more than a keystroke saver. The arrange step shrinks to the values that drive the result, so a reader sees them at once. And the data is not a constant: a test that only passes because the name is `"test"` stops passing.

Strongly typed IDs are usually fine out of the box. A `sealed record TeamId(int Value) : IntStrongType(Value)` has one constructor taking an `int`, and AutoFixture generates small positive integers, which pass a "positive" guard. The model tests of [Blouppy Starter](https://starter.blouppy.com/) run on a plain `new Fixture()`.


## Where it meets a domain model
A domain model is built to refuse bad states, and AutoFixture fills things in without knowing which states are bad. Money is the classic case. An `Amount` is a record of a value and a currency, and a plan holding a monthly and an annual price checks that both share one currency. AutoFixture picks each enum value independently, so it builds two amounts in different currencies, and the plan's constructor throws.

There is a second trap in the same record. Its positional properties have `init` accessors, which AutoFixture treats as writable. Even after building an `Amount` through its constructor, it sets `Value` and `Currency` again with random values.

The fix is to tell AutoFixture how to build the type, once, in an `ICustomization`. Here is the Starter's:

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

`FromFactory` asks the fixture for a `decimal` and builds the amount through the real constructor, so the non-negative guard still runs. `OmitAutoProperties` is the line that is easy to forget: without it, the fixed currency is overwritten after construction.

Going through the real constructor matters for a second reason. If the rule of `Amount` changes, a customization that sets fields directly keeps building the old shape, and the tests pass on data the model would now refuse. A factory keeps the guards in the loop.


## A rule about a kind of request
`Customize<T>` is about one type. When the rule is about a kind of request, `ISpecimenBuilder` is the general tool. AutoFixture asks each builder in turn, and a builder returns a specimen, or `NoSpecimen` to say "not mine".

The Starter's database tests need one. For a `string` parameter named `value`, AutoFixture generates the parameter name followed by a GUID. A `UserId` built that way is 41 characters long, and every `UserId` column is mapped with `HasMaxLength(36)`. In memory nothing complains; PostgreSQL refuses the insert. So a builder answers that one request (trimmed):

```csharp
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

A bare GUID string is 36 characters. The builder still asks the context for the GUID, so the value stays anonymous.

A builder can match properties too. Another one returns `OmitSpecimen` for `Id` and the audit columns, so the database assigns the key and the interceptors fill `CreatedBy`, as in production.


## One fixture per test project
Customizations are only useful if every test gets them. The Starter derives a `Fixture` per test project and applies them in its constructor:

```csharp
public sealed class DatabaseEntityFixture : Fixture
{
    public DatabaseEntityFixture()
    {
        Customize(new MicrosecondDateTimeOffsetCustomization());
        Customize(new UserIdCustomization());
        Customize(new AmountCustomization());
    }
}
```

Each fixture carries only what its project needs (simplified: the real one also omits the generated columns). The database rules, column lengths and the microsecond precision PostgreSQL stores, stay out of the domain's unit tests.

For what one test pins, `Build<T>()` is the per-call version: `.With(x => x.UserId, () => userId)` sets a member, `.Without(x => x.OrganizationId)` leaves it null, and everything else stays anonymous. `With` only reaches what AutoFixture could set anyway, though. A private setter stays out of reach, and the Starter's `Given_a_*()` helpers set those through a small reflection helper, in the arrange step only.


## Values the assertion depends on
AutoFixture's randomness has two sides.

**It can hide the case under test.** A test that checks an update changes a workspace's colour passes only if the new colour differs from the old one. With AutoFixture generating both, it depends on the order the enum values come out. When a value matters to the assertion, set it explicitly.

**It can make a test pass by luck.** Say a validator rejects names over 100 characters. The generated name is a short prefix and a GUID, so the "valid name" test passes without anyone choosing a valid name, until the limit changes. A boundary is written by hand, in an `[InlineData]`.

For a domain model's own tests, calling the constructor by hand often reads best. The Starter's `TeamTests` passes `_fixture.Create<string>()` and friends as arguments, but writes the constructor call itself, so it shows what a team needs and a new parameter breaks the test at compile time. AutoFixture is better for the rest: input records passed through a service, entities that only need to exist, DTOs. That is most of the arrange code in a service test, and it is where removing noise pays.


## References
- [AutoFixture](https://autofixture.github.io/) — the project's documentation and cheat sheet.
- [AutoFixture on GitHub](https://github.com/AutoFixture/AutoFixture) — source and the wiki on customizations and specimen builders.
- [Init-only setters](https://learn.microsoft.com/dotnet/csharp/language-reference/keywords/init) — Microsoft Learn: why a record's positional properties are writable through reflection.
- [Strongly typed IDs in C# with EF Core and PostgreSQL](/blog/2026-05-16-strongly-typed-ids-with-ef-core/) — the IDs themselves and how they map.
