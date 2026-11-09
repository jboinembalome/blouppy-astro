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

A price is a `decimal`, a currency is a `string`, and a plan has both. Nothing stops a method from adding euros to dollars, from storing `"usd "` with a trailing space, or from accepting `-5` as a monthly amount. Each rule becomes an `if` repeated across callers, and the one that forgets it writes bad data.

A value object puts the rule in one constructor.


## Entity or value
The pattern comes from Eric Evans' *Domain-Driven Design*. An **entity** has an identity that lasts while its attributes change. A **value object** is defined entirely by its attributes: two amounts of 10 EUR are the same amount. Three properties follow. Two instances with the same attributes are equal. Changing a value means building a new one. And the constructor refuses what the concept cannot be, so once we hold an instance, we no longer check it.


## A record does most of the work
A C# [`record`](https://learn.microsoft.com/dotnet/csharp/language-reference/builtin-types/record) gives equality by value, `GetHashCode`, `==` and `!=` without code. The older `ValueObject` base class with its `GetEqualityComponents()` is no longer needed. Here is the amount from [Blouppy Starter](https://starter.blouppy.com/)'s shared kernel:

```csharp
public sealed record Amount(decimal Value, Currency Currency)
{
    /// <summary>The amount value. Zero is allowed (free plans); negative is not.</summary>
    public decimal Value { get; } = ThrowIfNullOrNegative(Value);

    public static Amount Zero(Currency currency)
        => new(0m, currency);
}
```

`Currency` is a value object too. Its constructor trims the code, puts it in upper case and refuses anything but three ASCII letters, so `"usd "` becomes `USD`. A method that takes an `Amount` no longer validates anything. The `Plan` entity that holds a monthly and an annual `Amount` checks the one rule between them: both use the same currency.


## The `with` trap
Notice that `Value` is declared `{ get; }`, not `{ get; init; }`. That is on purpose. Here is the version most of us would write first:

```csharp
public sealed record Amount(decimal Value, Currency Currency)
{
    public decimal Value { get; init; } = ThrowIfNullOrNegative(Value);
}

var price = new Amount(10m, Currency.Eur);
var forged = price with { Value = -1m }; // compiles, no check
```

The `with` expression copies the record, then calls the `init` accessors of the properties it names. The property initializer, where the check runs, belongs to the primary constructor, so it is not called again. `forged.Value` is `-1`.

There are three fixes. Make the property get-only, as the Starter does: `price with { Value = -1m }` then no longer compiles. Validate in the accessor itself, `init => _value = Check(value);`, which runs on construction and on `with` alike. Or write a plain constructor with get-only properties, leaving nothing for `with` to assign.


## Equality stops at collections
A record compares each field with `EqualityComparer<T>.Default`. For an array or a `List<T>`, that is reference equality, so `new Tags(["a"]) == new Tags(["a"])` is `false`. A value object holding a collection either overrides `Equals` and `GetHashCode`, or the collection is compared explicitly where it matters. A project-management app built on the Starter does the latter: when an issue's labels change, the handler compares the old and new label IDs as sets.


## Storing it with EF Core 10
For a single value, a [value converter](https://learn.microsoft.com/ef/core/modeling/value-conversions) maps it to one column. `Currency` goes through the same convention as the strongly typed IDs, described in [their own article](/blog/2026-05-16-strongly-typed-ids-with-ef-core/).

For several fields, a complex type keeps them as columns in the owner's table. Complex types have no key and are compared by value, which is exactly the pattern. The billing module maps each `Amount` of a plan like this:

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

The `plans` table gets `monthly_price numeric(18,2)` and `monthly_currency character varying(3)`. Since [EF Core 10](https://learn.microsoft.com/ef/core/what-is-new/ef-core-10.0/whatsnew), a complex property can be optional, and `ToJson()` stores a complex type in a single `jsonb` column. A collection of value objects must be mapped that way.


## When a string is enough
The Starter's organization slug is a plain `string`. A static class, `OrganizationSlug`, holds its rules, and the entity calls it in its constructor and in its rename. Checked where it enters the aggregate, the slug flows into routes and JSON with no converter.

A guarded primitive is enough when one aggregate owns the value, when nothing computes with it, and when it crosses many edges that would each need a conversion. A value object pays off when the value travels inside the domain, has more than one field, or has operations of its own: an amount with its currency, quiet hours that wrap midnight.

One cost stays either way: a value object throws at construction. That is right inside the domain, but user input still needs a validator that returns a readable error before the constructor is reached.


## References
- [Value Object (Martin Fowler)](https://martinfowler.com/bliki/ValueObject.html) — a short definition and its aliasing problem.
- [Nondestructive mutation with `with` (Microsoft Learn)](https://learn.microsoft.com/dotnet/csharp/language-reference/operators/with-expression) — the copy constructor and `init` accessors.
- [What's new in EF Core 10 (Microsoft Learn)](https://learn.microsoft.com/ef/core/what-is-new/ef-core-10.0/whatsnew) — optional complex types, JSON and complex collections.
- [Strongly typed IDs in C# with EF Core and PostgreSQL](/blog/2026-05-16-strongly-typed-ids-with-ef-core/) — the single-value case in detail.
