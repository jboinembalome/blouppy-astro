---
templateKey: 'blog-post'
title: 'Difference between const and readonly in C#'
date: 2022-03-09T18:04:10.000Z
updated: 2026-11-07T09:00:00.000Z
author: Jimmy Boinembalome
authorimage: /img/jimmy.jpg
category: C#
topic: 'C# & .NET'
illustration: 1
categorycolor: bg-purple-100 text-purple-800
featuredpost: true
featuredimage: /img/difference_between_const_and_readonly_in_csharp.jpg
description: >-
  What really separates const from readonly in C#: which types each accepts, where it can be declared, and why a public const can go stale across assemblies.
tags:
  - Development
  - C#
  - Const
  - Readonly
---

> **Updated November 2026:** I checked everything again on .NET 10 with two real projects, fixed the list of types a `const` accepts and a sample that no longer compiled, and switched to file-scoped namespaces and top-level statements.

When we need a value that never changes, C# gives us two keywords: `const` and `readonly`. They look interchangeable, but they behave differently, and one difference can break an application after a library update.

## The const keyword
A [`const`](https://learn.microsoft.com/dotnet/csharp/language-reference/keywords/const) declares a value that is fixed at compile time:

```csharp
public static class Colour
{
    public const string ConstRed = "#FF0000";
}
```

- A `const` is implicitly `static`: we read `Colour.ConstRed` without an instance. Adding `static` ourselves is an error: `error CS0504: The constant 'ConstRed' cannot be marked static`.
- A `const` can also be declared inside a method, as a [local constant](https://learn.microsoft.com/dotnet/csharp/language-reference/statements/declarations).
- A `const` only accepts the built-in numeric types (`int`, `double`, `decimal`…), `bool`, `char`, `string` and enums. Any other reference type can only be a `const` with the value `null`. A `DateTime`, or any other struct, cannot be a `const` (`error CS0283: The type 'DateTime' cannot be declared const`): that is a job for `static readonly`.
- Since C# 10, a `const string` can be an [interpolated string](https://learn.microsoft.com/dotnet/csharp/language-reference/tokens/interpolated), as long as every part of it is itself a constant string:

```csharp
public static class Colour
{
    public const string Hash = "#";
    public const string ConstRed = $"{Hash}FF0000";
}
```

## The readonly keyword
A [`readonly`](https://learn.microsoft.com/dotnet/csharp/language-reference/keywords/readonly) field can only be assigned in its declaration, in a constructor of the same class, or in an `init` accessor:

```csharp
public class Colour
{
    public readonly string ReadOnlyRed;

    public Colour()
    {
        ReadOnlyRed = "#FF0000";
    }

    public Colour(string red)
    {
        ReadOnlyRed = red;
    }
}
```

A `readonly` field can also be `static`:

```csharp
public static class Colour
{
    public static readonly string ReadOnlyRed = "#FF0000";
}
```

- As a variable modifier, `readonly` only applies to fields. A `readonly` local variable does not compile: `error CS0106: The modifier 'readonly' is not valid for this item`.
- A `readonly` field accepts any type, value or reference. With a reference type, `readonly` protects the reference, not the object: we can still change the object's properties, but we cannot replace it with another object.

## The difference that matters
A `const` is a compile-time constant: the compiler copies its value into every assembly that uses it. A `readonly` field is read at runtime.

Let's see what this means in practice. A class library, `Core`, holds a `Colour` class with a `const` and a `static readonly` field of the same value:

```csharp
namespace Core;

public static class Colour
{
    public const string ConstRed = "#FF0000";
    public static readonly string ReadOnlyRed = "#FF0000";
}
```

A console application, `SampleConstVsReadonly` (in the `App` folder, with a project reference to `Core`), prints both values. With [top-level statements](https://learn.microsoft.com/dotnet/csharp/fundamentals/program-structure/top-level-statements), its whole `Program.cs` is:

```csharp
using Core;

Console.WriteLine($"Const value: {Colour.ConstRed}.");
Console.WriteLine($"Readonly value: {Colour.ReadOnlyRed}.");
```

Running it prints:

```bash:clipboard=false
Const value: #FF0000.
Readonly value: #FF0000.
```

Now we change the red to `#EF4444` in both fields of `Core`. Since the application's code has not changed, we rebuild only `Core` and replace its DLL next to the application, without recompiling the application:

```bash
dotnet build Core
cp Core/bin/Debug/net10.0/Core.dll App/bin/Debug/net10.0/Core.dll
dotnet App/bin/Debug/net10.0/SampleConstVsReadonly.dll
```

```bash:clipboard=false
Const value: #FF0000.
Readonly value: #EF4444.
```

Only the `readonly` value is updated. When the application was compiled, the compiler replaced `Colour.ConstRed` with `"#FF0000"` in the application's own DLL, so it never asks `Core` for it. The `readonly` field, on the other hand, is read from `Core` every time the application runs.

Recompiling the application (`dotnet build App`) fixes it: both lines then show `#EF4444`.

This is why the [.NET design guidelines](https://learn.microsoft.com/dotnet/standard/design-guidelines/field) reserve constant fields for values that will never change, such as `Math.PI`. For a public value that may change in a future version of a library, use a `static readonly` field.

## Conclusion
`const` and `readonly` both prevent a value from changing, but a `const` is resolved at compile time and a `readonly` field at runtime. When a public `const` changes in a library, every project that references it must be recompiled to see the new value.

If you have questions about `const` and `readonly`, I will be happy to discuss them in the comments.

## References
- [const keyword](https://learn.microsoft.com/dotnet/csharp/language-reference/keywords/const) — C# reference: the types a constant accepts and local constants.
- [readonly keyword](https://learn.microsoft.com/dotnet/csharp/language-reference/keywords/readonly) — C# reference: where a `readonly` field can be assigned, and how it differs from `const`.
- [Constants (C# programming guide)](https://learn.microsoft.com/dotnet/csharp/programming-guide/classes-and-structs/constants) — why a program keeps the old value of a constant until it is recompiled.
- [Field design guidelines](https://learn.microsoft.com/dotnet/standard/design-guidelines/field) — when to use constant fields and when to use `static readonly` fields.
- [String interpolation](https://learn.microsoft.com/dotnet/csharp/language-reference/tokens/interpolated) — constant interpolated strings (C# 10).
- [Top-level statements](https://learn.microsoft.com/dotnet/csharp/fundamentals/program-structure/top-level-statements) — the `Program.cs` style used in the sample.
