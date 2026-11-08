---
templateKey: 'blog-post'
title: 'Value objects in C# with records'
date: 2026-11-26T09:00:00.000Z
author: Jimmy Boinembalome
authorimage: /img/jimmy.jpg
category: C#
topic: 'Architecture'
illustration: 3
categorycolor: bg-purple-100 text-purple-800
featuredpost: true
description: >-
  Learn the Value Object pattern in C#: records for equality by value, the with expression and collection traps, mapping with EF Core 10 complex types and JSON, and when a string is enough.
tags:
  - Development
  - C#
  - Design Patterns
  - DDD
  - EF Core
---

A price is a `decimal`, a currency is a `string`, and a plan has both. Nothing stops a method from adding a price in euros to a price in dollars, from storing `"usd "` with a trailing space, or from accepting `-5` as a monthly amount. Each rule becomes an `if` repeated across callers, and the one that forgets it writes bad data.

In this article, we will look at the **Value Object** pattern: what it is, how C# records give most of it for free, the two places where records fall short, how EF Core 10 stores value objects, and when a plain `string` or `int` is the better choice.


## What a value object is
The pattern comes from Eric Evans' *Domain-Driven Design*, and Martin Fowler describes it in his catalog of enterprise patterns. It is not a Gang of Four pattern. An **entity** has an identity that lasts while its attributes change; a **value object** is defined entirely by its attributes (two amounts of 10 EUR are the same amount).

Three properties follow:

- **Equality by value.** Two instances with the same attributes are equal. There is no ID to compare.
- **Immutability.** Changing a value means building a new one.
- **Valid from construction.** The constructor refuses what the concept cannot be. Once we hold an instance, we no longer check it.


## The cost of primitive obsession
*Primitive obsession* is modelling domain concepts with `string`, `int` and `decimal`:

- **An e-mail address as a `string`.** Is `"Bob@Example.com"` equal to `"bob@example.com"`? Every comparison has to decide.
- **A URL slug as a `string`.** It must be lowercase, a few characters long and not a reserved route. Any `string` parameter accepts `"Settings!"`.
- **An amount as a `decimal`.** The currency travels in a second parameter that can be swapped, forgotten or mismatched.
- **A position on a progress hill as an `int`.** The rule says 0 to 100, and the type says -2 147 483 648 to 2 147 483 647.


## A minimal value object with a record
A C# [`record`](https://learn.microsoft.com/dotnet/csharp/language-reference/builtin-types/record) gives equality by value, `GetHashCode`, `==` and `!=` without code. [Blouppy Starter](https://starter.blouppy.com/) still carries the older `ValueObject` base class with its `GetEqualityComponents()`, from Microsoft's microservices guide; nothing derives from it any more.

Here is an e-mail address as a record:

```csharp
namespace Contacts;

public sealed record EmailAddress
{
    public EmailAddress(string value)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(value);

        var normalized = value.Trim().ToLowerInvariant();

        if (!normalized.Contains('@'))
        {
            throw new ArgumentException($"'{value}' is not an e-mail address.", nameof(value));
        }

        Value = normalized;
    }

    public string Value { get; }

    public override string ToString()
        => Value;
}
```

`new EmailAddress("Bob@Example.com") == new EmailAddress("bob@example.com")` is `true`, because the constructor normalizes before the record compares. A method that takes an `EmailAddress` no longer validates anything.

Strongly typed IDs are value objects too, wrapping a single primitive; they have [their own article](/blog/2026-05-16-strongly-typed-ids-with-ef-core/), so we focus here on values with rules and several fields.


## Trap one: `with` skips the constructor
The example above is not a positional record on purpose. Here is the shorter version most of us would write first:

```csharp
public sealed record EmailAddress(string Value)
{
    public string Value { get; init; } = Validate(Value);
}

var email = new EmailAddress("bob@example.com");
var forged = email with { Value = "not an e-mail" }; // compiles, no check
```

The `with` expression calls the record's copy constructor and then the `init` accessors of the properties it names. The property initializer, where `Validate` runs, belongs to the primary constructor, so it is not called. `forged.Value` is `"not an e-mail"`. We checked this on .NET 10.

There are three fixes:

- **Make the property get-only.** With `public string Value { get; } = Validate(Value);`, the `with` expression no longer compiles (`CS0200`: the property is read only).
- **Validate in the `init` accessor.** `init => _value = Validate(value);` runs on construction and on `with` alike.
- **Write a plain constructor with get-only properties**, as in `EmailAddress` above. There is nothing for `with` to assign.

The Starter's `Amount` uses the first fix:

```csharp
namespace Blouppy.SharedKernel.ValueObjects;

public sealed record Amount(decimal Value, Currency Currency)
{
    /// <summary>The amount value. Zero is allowed (free plans); negative is not.</summary>
    public decimal Value { get; } = ThrowIfNullOrNegative(Value);

    public static Amount Zero(Currency currency)
        => new(0m, currency);
}
```

`amount with { Value = -1m }` does not compile. `amount with { Currency = ... }` does, which is safe here because a `Currency` validates itself:

```csharp
public sealed record Currency : StringStrongType
{
    public static readonly Currency Usd = new("USD");
    public static readonly Currency Eur = new("EUR");

    public Currency(string value)
        : base(Normalize(value)) // trimmed, upper case, three ASCII letters, or ArgumentException
    {
    }
}
```

The `Plan` entity holding a monthly and an annual `Amount` checks the rule between them: it refuses two different currencies.


## Trap two: equality stops at collections
A record compares each field with `EqualityComparer<T>.Default`. For an array or a `List<T>`, that is reference equality:

```csharp
public sealed record Tags(IReadOnlyList<string> Items);

new Tags(["a"]) == new Tags(["a"]); // false
```

A project-management app built on the Starter meets this in its issue events. Each changed field of an issue travels as a `PropertyValueChange<T>`, a record value from the SharedKernel:

```csharp
public record PropertyValueChange<TProperty>(TProperty OldValue, TProperty NewValue)
{
    public static implicit operator PropertyValueChange<TProperty>(
        (TProperty OldValue, TProperty NewValue) change)
        => new(change.OldValue, change.NewValue);
}
```

The handler that tells open boards to refresh compares most fields with `EqualityComparer<T>.Default`, but the labels are a `PropertyValueChange<IReadOnlyCollection<LabelId>>`, and two arrays with the same IDs are never equal. So that one field is compared as a set:

```csharp
var cardChanged = Changed(@event.Name)
                  || Changed(@event.Priority)
                  || Changed(@event.Progress)
                  || !@event.LabelIds.OldValue.ToHashSet().SetEquals(@event.LabelIds.NewValue);
```

A value object holding a collection either overrides `Equals(T? other)` and `GetHashCode`, or the collection is compared explicitly where it matters, as here.


## A value object with behaviour
Value objects are a good home for logic about the value. The Starter's notification preferences have quiet hours, and the rule "22:00 to 07:00 is one night" lives in the value:

```csharp
namespace Blouppy.Notifications.Models.Preferences;

public sealed record QuietHours
{
    public QuietHours(TimeOnly start, TimeOnly end)
    {
        Exceptions.ThrowIf(
            start,
            value => value == end,
            "Quiet hours that start when they end describe either no time at all or every hour of the day.");

        Start = start;
        End = end;
    }

    public TimeOnly Start { get; }

    public TimeOnly End { get; }

    public bool Covers(TimeOnly localTime)
        => Start < End
            ? localTime >= Start && localTime < End
            : localTime >= Start || localTime < End;
}
```

`Covers` is tested once, on its own, with no database and no mock.


## Mapping value objects with EF Core 10
EF Core offers several tools.

**A value converter, for a single value.** `Currency` derives from `StringStrongType`, so the convention that maps every strongly typed ID maps it too: `ApplyStrongTypeConvertersFromAssembly` in `ConfigureConventions` registers a [value converter](https://learn.microsoft.com/ef/core/modeling/value-conversions) to `string`.

**A complex type, for several columns in the owner's table.** [Complex types](https://learn.microsoft.com/ef/core/what-is-new/ef-core-8.0/whatsnew) arrived in EF Core 8 for exactly this pattern: no key, no identity, compared by value. The billing module's plan configuration maps each `Amount` to two columns:

```csharp
builder
    .ComplexProperty(x => x.MonthlyAmount, amount =>
    {
        amount
            .Property(x => x.Value)
            .HasColumnName("monthly_price")
            .HasPrecision(18, 2);

        amount
            .Property(x => x.Currency)
            .HasColumnName("monthly_currency")
            .HasMaxLength(CurrencyCodeLength);
    });
```

The migration creates `monthly_price numeric(18,2)` and `monthly_currency character varying(3)` on the `plans` table, and the `Currency` inside goes through its converter. Records work as complex types, and so do structs. Since [EF Core 10](https://learn.microsoft.com/ef/core/what-is-new/ef-core-10.0/whatsnew), a complex property can be optional: a `Money?` property gives nullable columns.

**A JSON column.** EF Core 10 maps a complex type to a single JSON column with `ToJson()`, a `jsonb` column on PostgreSQL. A collection of value objects is a `ComplexCollection`, and it must be mapped to JSON: without `ToJson()`, EF Core 10 refuses the model ("The complex collection property ... must be mapped to a JSON column").

**An owned type**, the older tool, is an entity with a hidden key. The Starter uses `OwnsMany` for the actions of an assistant proposal, whose status changes over time: a child entity, which a complex type would not fit.

**Or no mapping at all.** `QuietHours` is not mapped. `NotificationPreferences` stores two nullable `TimeOnly` columns, `QuietHoursStart` and `QuietHoursEnd`, builds the value in a computed property and the configuration calls `builder.Ignore(x => x.QuietHours)`. The domain type then needs nothing from EF Core.


## When a plain string is fine
The Starter's organization slug is a `string`. Its rules live in a static class, `OrganizationSlug`, with `IsValid`, `ThrowIfInvalid` and `From(text)`, and the entity calls it in its constructor and in its rename:

```csharp
public string Slug { get; private set; } = OrganizationSlug.ThrowIfInvalid(slug);
```

Checked where it enters the aggregate, it flows into routes and JSON with no converter. The project-management app does the same with the hill position of a scope: an `int?` on the issue, checked with `Exceptions.ThrowIf(progress, x => x is < 0 or > 100, ...)` in the methods that move it. Its daily `HillPosition` record is an entity, with its own ID and a row per scope and day, because each row is a fact in the history with an identity of its own.

A guarded primitive is enough when:

- **One aggregate owns the value** and guards it in its own methods.
- **The value has no behaviour.** A slug is matched and displayed; nothing computes with it.
- **It crosses many edges.** Every API, cache key and event that carries it would need a conversion.

A value object pays off when the value is passed around inside the domain, has more than one field, or has operations of its own: an amount with its currency, quiet hours that wrap midnight.


## What it costs
- **A type per concept**, and a mapping for each in EF Core, in JSON and at the API edge.
- **Exceptions at construction.** A value object that throws is right inside the domain. User input still needs a validator that returns a readable error before the constructor is reached.


## Conclusion
A value object moves a rule from every caller into one constructor, and gives equality by value and immutability on top. Records provide the equality, as long as validation survives `with` and collections are compared on purpose. EF Core 10 stores them as columns with `ComplexProperty`, as JSON with `ToJson()`, or through a converter. And when one aggregate guards a primitive with no behaviour, the `string` is fine.

`Amount`, `Currency` and `QuietHours` are all in [Blouppy Starter](https://starter.blouppy.com/).

## References
- [Domain-Driven Design (Eric Evans)](https://www.domainlanguage.com/ddd/) — the book that defines entities and value objects.
- [Value Object (Martin Fowler)](https://martinfowler.com/bliki/ValueObject.html) — a short definition and its aliasing problem.
- [Implement value objects (Microsoft Learn)](https://learn.microsoft.com/dotnet/architecture/microservices/microservice-ddd-cqrs-patterns/implement-value-objects) — the `ValueObject` base class and owned types.
- [Records (Microsoft Learn)](https://learn.microsoft.com/dotnet/csharp/language-reference/builtin-types/record) — value equality, positional records and `with`.
- [Nondestructive mutation with `with` (Microsoft Learn)](https://learn.microsoft.com/dotnet/csharp/language-reference/operators/with-expression) — the copy constructor and `init` accessors.
- [What's new in EF Core 10 (Microsoft Learn)](https://learn.microsoft.com/ef/core/what-is-new/ef-core-10.0/whatsnew) — optional complex types, JSON and complex collections.
- [Value conversions (Microsoft Learn)](https://learn.microsoft.com/ef/core/modeling/value-conversions) — mapping a single value to a column.
- [Owned entity types (Microsoft Learn)](https://learn.microsoft.com/ef/core/modeling/owned-entities) — the older tool, entities with a hidden key.
- [Strongly typed IDs in C# with EF Core and PostgreSQL](/blog/2026-05-16-strongly-typed-ids-with-ef-core/) — the single-value case in detail.
