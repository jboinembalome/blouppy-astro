---
templateKey: 'blog-post'
title: 'Using nullable reference types in C# projects'
date: 2022-04-17T17:28:10.000Z
updated: 2026-11-07T09:00:00.000Z
author: Jimmy Boinembalome
authorimage: /img/jimmy.jpg
category: C#
topic: 'C# & .NET'
illustration: 3
categorycolor: bg-purple-100 text-purple-800
featuredpost: true
featuredimage: /img/using-nullable-reference-types-in-csharp-projects.jpg
description: >-
  How nullable reference types let the C# compiler catch null references: enabling them, the ? and ! operators, [NotNullWhen], #nullable and warnings as errors.
tags:
  - Development
  - C#
  - Features
---

> **Updated November 2026:** the samples now target .NET 10, where nullable reference types are on by default, and I added the tools we use every day with them: the `!` operator, the `#nullable` directive, the `[NotNullWhen]` attribute and turning the warnings into errors.

C# 8.0 brought [several new features](https://www.blouppy.com/blog/2022-04-11-some-features-of-csharp8-to-reduce-our-code/). In this article, we focus on one of them: [nullable reference types](https://learn.microsoft.com/dotnet/csharp/fundamentals/null-safety/nullable-reference-types).

## Nullable reference types
A [value type](https://learn.microsoft.com/dotnet/csharp/language-reference/builtin-types/nullable-value-types) only accepts `null` when we add `?` to it:

```csharp
int? a = null;

// error CS0037: Cannot convert null to 'int' because it is a non-nullable value type
int b = null;
```

A reference type, on the other hand, has always accepted `null`. Nothing in its declaration says whether `null` is expected, so we have to check before using it.

Let's take an extension method that counts the words in a string:

```csharp
public static class StringExtensions
{
    public static int CountWords(this string text)
    {
        return text.Split(' ', StringSplitOptions.RemoveEmptyEntries).Length;
    }
}
```

We use it in the top-level statements of `Program.cs`:

```csharp
string message = "We love C# and .NET";
int count = string.IsNullOrWhiteSpace(message) ? 0 : message.CountWords();

Console.WriteLine($"Count words: {count}");
```

```bash:clipboard=false
Count words: 5
```

`CountWords` throws a `NullReferenceException` when `text` is null, so we check `message` before calling it. Nullable reference types let the compiler track which references can be null, the same way it does for value types.

We enable them with the `Nullable` element of the `.csproj` file:

```xml{5}
<PropertyGroup>
    <OutputType>Exe</OutputType>
    <TargetFramework>net10.0</TargetFramework>
    <ImplicitUsings>enable</ImplicitUsings>
    <Nullable>enable</Nullable>
</PropertyGroup>
```

> **_Note:_** Since .NET 6, the project templates (`dotnet new console`, `dotnet new webapi`…) already contain `<Nullable>enable</Nullable>`, so a new project has nullable reference types on from the start. We only add it ourselves to older projects. The element exists since .NET Core 3.0 and C# 8.0.

Now, if we set `message` to `null`, the compiler warns us:

```csharp
string message = null;
```

```bash:clipboard=false
warning CS8600: Converting null literal or possible null value to non-nullable type.
```

To declare that a reference can be null, we add `?` to its type:

```csharp
string? message = null;
```

## Why no warning on message.CountWords()?
`message` can now be null, yet the compiler says nothing about `message.CountWords()` on the next line. The compiler follows the flow of our code, and [`string.IsNullOrWhiteSpace`](https://learn.microsoft.com/dotnet/api/system.string.isnullorwhitespace) tells it something: its parameter is declared `[NotNullWhen(false)] string? value`, meaning "if I return `false`, the value was not null". In the `:` branch, the compiler therefore knows that `message` is not null.

We can put the same attribute, from [`System.Diagnostics.CodeAnalysis`](https://learn.microsoft.com/dotnet/csharp/language-reference/attributes/nullable-analysis), on our own methods:

```csharp
using System.Diagnostics.CodeAnalysis;

public static class TextHelper
{
    public static bool HasWords([NotNullWhen(true)] string? text)
    {
        return !string.IsNullOrWhiteSpace(text);
    }
}
```

```csharp
string? message = Console.ReadLine();
if (TextHelper.HasWords(message))
    Console.WriteLine($"Count words: {message.CountWords()}");
```

Without `[NotNullWhen(true)]`, the compiler cannot know what `HasWords` checks, and warns us:

```bash:clipboard=false
warning CS8604: Possible null reference argument for parameter 'text' in 'int StringExtensions.CountWords(string text)'.
```

Other attributes of the same family, such as `[NotNull]`, `[MaybeNullWhen]` and `[MemberNotNull]`, cover the other situations.

## The null-forgiving operator !
Sometimes we know better than the compiler. `Console.ReadLine()` returns a `string?` because it returns `null` when the input has no more lines. In a small tool that always reads from the keyboard, the [null-forgiving operator `!`](https://learn.microsoft.com/dotnet/csharp/language-reference/operators/null-forgiving) tells the compiler that the value is not null:

```csharp
string input = Console.ReadLine()!;
Console.WriteLine($"Count words: {input.CountWords()}");
```

The `!` only removes the warning. Nothing is checked at runtime: if we are wrong, we get a `NullReferenceException`. Use it sparingly.

## The #nullable directive
On a large existing project, enabling nullable reference types everywhere at once can produce hundreds of warnings. The [`#nullable` directive](https://learn.microsoft.com/dotnet/csharp/language-reference/preprocessor-directives) changes the setting for part of a file, so we can [migrate step by step](https://learn.microsoft.com/dotnet/csharp/nullable-migration-strategies):

```csharp
#nullable disable
public class LegacyCustomer
{
    public string Name { get; set; } // no warning: nullable is disabled here
}
#nullable restore

public class Customer
{
    // warning CS8618: Non-nullable property 'Name' must contain a non-null value when exiting constructor.
    // Consider adding the 'required' modifier or declaring the property as nullable.
    public string Name { get; set; }
}
```

`#nullable restore` returns to the project's setting. As the warning suggests, the fix for `Customer` is either `string?` or the [`required`](https://learn.microsoft.com/dotnet/csharp/language-reference/keywords/required) modifier (`public required string Name { get; set; }`), which makes every caller set `Name`.

We can also work the other way round: keep `<Nullable>disable</Nullable>` in the project and add `#nullable enable` at the top of each migrated file.

## Turning the warnings into errors
A warning is easy to ignore. To stop null problems from getting in, we can [treat every nullable warning as an error](https://learn.microsoft.com/dotnet/csharp/language-reference/compiler-options/errors-warnings) without touching the other warnings:

```xml{6}
<PropertyGroup>
    <OutputType>Exe</OutputType>
    <TargetFramework>net10.0</TargetFramework>
    <ImplicitUsings>enable</ImplicitUsings>
    <Nullable>enable</Nullable>
    <WarningsAsErrors>nullable</WarningsAsErrors>
</PropertyGroup>
```

The `string message = null;` sample above no longer builds:

```bash:clipboard=false
error CS8600: Converting null literal or possible null value to non-nullable type.
```

## Conclusion
A `?` after a reference type can look strange at first. Once we know it, nullable reference types let the compiler point out null references while we write the code, instead of at runtime. And since .NET 6, they are on by default.

Do you use nullable reference types in your projects? Tell me in the comments.

## References
- [Nullable reference types](https://learn.microsoft.com/dotnet/csharp/fundamentals/null-safety/nullable-reference-types) — Microsoft Learn: null-state analysis, annotations and the nullable context.
- [Attributes for null-state static analysis](https://learn.microsoft.com/dotnet/csharp/language-reference/attributes/nullable-analysis) — `[NotNullWhen]`, `[NotNull]`, `[MaybeNullWhen]`, `[MemberNotNull]` and the others.
- [Null-forgiving operator (!)](https://learn.microsoft.com/dotnet/csharp/language-reference/operators/null-forgiving) — what `!` does and does not do.
- [Nullable migration strategies](https://learn.microsoft.com/dotnet/csharp/nullable-migration-strategies) — enabling nullable reference types in an existing code base.
- [Preprocessor directives](https://learn.microsoft.com/dotnet/csharp/language-reference/preprocessor-directives) — `#nullable enable`, `disable` and `restore`.
- [Compiler options for errors and warnings](https://learn.microsoft.com/dotnet/csharp/language-reference/compiler-options/errors-warnings) — `WarningsAsErrors` and the `nullable` shorthand.
- [Resolve nullable warnings](https://learn.microsoft.com/dotnet/csharp/language-reference/compiler-messages/nullable-warnings) — the CS86xx warnings and how to fix each one.
- [Nullable value types](https://learn.microsoft.com/dotnet/csharp/language-reference/builtin-types/nullable-value-types) — `int?` and `Nullable<T>`.
- [required modifier](https://learn.microsoft.com/dotnet/csharp/language-reference/keywords/required) — making callers initialize a property.
