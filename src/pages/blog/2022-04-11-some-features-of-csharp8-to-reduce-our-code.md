---
templateKey: 'blog-post'
title: 'Some features of C# 8.0 to reduce our code'
date: 2022-04-11T17:28:10.000Z
updated: 2026-11-07T09:00:00.000Z
author: Jimmy Boinembalome
authorimage: /img/jimmy.jpg
category: C#
topic: 'C# & .NET'
illustration: 2
categorycolor: bg-purple-100 text-purple-800
featuredpost: true
featuredimage: /img/some-features-of-csharp8-to-reduce-our-code.jpg
description: >-
  Switch expressions, property and tuple patterns, using declarations, ??= and indices and ranges: the C# 8.0 features that make code shorter and clearer.
tags:
  - Development
  - C#
  - Features
---

> **Updated November 2026:** every sample now compiles without a warning on .NET 10 / C# 14, where nullable reference types are enabled by default, and I added a short list of the pattern features that came after C# 8.0.

[C# 8.0](https://learn.microsoft.com/dotnet/csharp/whats-new/csharp-version-history#c-version-80) was released in September 2019, together with .NET Core 3.0. In this article, we look at the features that make our code shorter or easier to read. They are all available in later versions of C#.

## Switch expression
The [`switch` expression](https://learn.microsoft.com/dotnet/csharp/language-reference/operators/switch-expression) is a more concise way to write a `switch` statement that returns a value: no more `case`, `break` or `return` on every branch.

Traditional way:

```csharp
public static string DoYouLikeCSharp8(bool? answer)
{
    switch (answer)
    {
        case true:
            return "It's fun!";
        case false:
            return "The next versions will satisfy you better!";
        default:
            return "Oh... Do you prefer another language?";
    }
}
```

New way:

```csharp
public static string DoYouLikeCSharp8(bool? answer)
{
    return answer switch
    {
        true => "It's fun!",
        false => "The next versions will satisfy you better!",
        _ => "Oh... Do you prefer another language?",
    };
}
```

The discard `_` plays the role of `default`.

## Property and tuple patterns
### Property pattern
A [property pattern](https://learn.microsoft.com/dotnet/csharp/language-reference/operators/patterns#property-pattern) matches an object on the values of its properties. Let's take a language and a level:

```csharp
public enum Level
{
    Notion,
    Practice,
    Autonomous,
    Expert,
}

public record Language(string Name, Level Level);
```

> **_Note:_** A [`record`](https://learn.microsoft.com/dotnet/csharp/language-reference/builtin-types/record) (C# 9) with a primary constructor declares the two properties and the constructor in one line. The property pattern works the same way with a plain class.

Traditional way:

```csharp
public static string GetLevelMessage(Language language)
{
    if (language.Name == "C#" && language.Level == Level.Notion)
        return "You have some notions of C#!";
    if (language.Name == "C#" && language.Level == Level.Practice)
        return "You practice C#!";
    if (language.Name == "C#" && language.Level == Level.Autonomous)
        return "You are autonomous in C#!";
    if (language.Name == "C#" && language.Level == Level.Expert)
        return "You are an expert in C#!";

    return $"I don't know your level in {language.Name}, but I'm sure you are good!";
}
```

New way:

```csharp
public static string GetLevelMessage(Language language)
{
    return language switch
    {
        { Name: "C#", Level: Level.Notion } => "You have some notions of C#!",
        { Name: "C#", Level: Level.Practice } => "You practice C#!",
        { Name: "C#", Level: Level.Autonomous } => "You are autonomous in C#!",
        { Name: "C#", Level: Level.Expert } => "You are an expert in C#!",
        _ => $"I don't know your level in {language.Name}, but I'm sure you are good!",
    };
}
```

### Tuple pattern
When the values are not in one object, a [positional pattern](https://learn.microsoft.com/dotnet/csharp/language-reference/operators/patterns#positional-pattern) matches a tuple built on the fly:

```csharp
public static string GetLevelMessage(Level level, string language)
{
    return (level, language) switch
    {
        (Level.Notion, "C#") => $"You have some notions of {language}!",
        (Level.Practice, "C#") => $"You practice {language}!",
        (Level.Autonomous, "C#") => $"You are autonomous in {language}!",
        (Level.Expert, "C#") => $"You are an expert in {language}!",
        _ => $"I don't know your level in {language}, but I'm sure you are good!",
    };
}
```

## Using declaration
Some objects must be disposed once we are done with them, such as a `StreamReader` that reads a file or a `SqlConnection`. The [`using` statement](https://learn.microsoft.com/dotnet/csharp/language-reference/statements/using) disposes the object at the end of its block, so we do not have to call `Dispose` in a `try`/`finally` ourselves.

Traditional way:

```csharp
public static void ReadFile(string path)
{
    using (var streamReader = new StreamReader(path))
    {
        string? line;
        while ((line = streamReader.ReadLine()) is not null)
            Console.WriteLine(line);
    } // streamReader is disposed here
}
```

Since C# 8.0, a `using` declaration disposes the variable at the end of the enclosing scope, without the extra block and indentation.

New way:

```csharp
public static void ReadFile(string path)
{
    using var streamReader = new StreamReader(path);
    string? line;
    while ((line = streamReader.ReadLine()) is not null)
        Console.WriteLine(line);
} // streamReader is disposed here
```

> **_Note:_** `line` is a `string?` because `ReadLine` returns `null` at the end of the file. Without the `?`, nullable reference types (another C# 8.0 feature, enabled by default in today's project templates) would warn us: `CS8600: Converting null literal or possible null value to non-nullable type.` I wrote [a whole article about them](https://www.blouppy.com/blog/2022-04-17-using-nullable-reference-types/).

## Null-coalescing assignment
The [null-coalescing operator `??`](https://learn.microsoft.com/dotnet/csharp/language-reference/operators/null-coalescing-operator) returns its left operand if it is not null, and its right operand otherwise:

```csharp
string? message = null;
message = message ?? "Default message"; // "Default message"
```

The null-coalescing assignment `??=` shortens this line: it assigns the right operand only when the variable is null.

```csharp
string? message = null;
message ??= "Default message";
```

## Indices and ranges
[Indices and ranges](https://learn.microsoft.com/dotnet/csharp/tutorials/ranges-indexes) give a short syntax to access one element or a slice of a sequence. Let's take an array (written with a collection expression, C# 12):

```csharp
string[] words =
[
    "happy", "sad", "yes", "no",
    "dog", "cat", "apple", "pear",
];
```

### Indices
The `^` operator counts from the end:

```csharp
var last = words[^1];       // words[words.Length - 1]: "pear"
var secondLast = words[^2]; // words[words.Length - 2]: "apple"
```

### Ranges
The `..` operator takes a range, from its start (included) to its end (excluded). Either bound can be omitted:

```csharp
var moods = words[..2];    // "happy", "sad"
var answers = words[2..4]; // "yes", "no"
var animals = words[4..6]; // "dog", "cat"
var fruits = words[6..];   // "apple", "pear"
```

## And since then?
[Pattern matching](https://learn.microsoft.com/dotnet/csharp/fundamentals/functional/pattern-matching) kept growing after C# 8.0. Two additions go well with the `switch` expression:
- **Relational and logical patterns** (C# 9): `<`, `>=`, `and`, `or`, `not`.
- **List patterns** (C# 11): match the shape of an array or a list, with `..` for "the rest".

```csharp
public static string GetAgeGroup(int age) => age switch
{
    < 0 => "Not born yet?",
    < 18 => "Young developer",
    >= 18 and < 65 => "Developer",
    _ => "Wise developer",
};

public static string Describe(int[] numbers) => numbers switch
{
    [] => "Empty",
    [var single] => $"Only {single}",
    [var first, .., var last] => $"From {first} to {last}",
};
```

## Conclusion
The C# 8.0 syntax can surprise developers who have not met it yet. Once learned, it makes our code shorter and easier to read.

## References
- [The history of C#: C# version 8.0](https://learn.microsoft.com/dotnet/csharp/whats-new/csharp-version-history#c-version-80) — every feature of C# 8.0 and of the versions after it.
- [switch expression](https://learn.microsoft.com/dotnet/csharp/language-reference/operators/switch-expression) — C# reference: syntax, discards and exhaustiveness.
- [Patterns](https://learn.microsoft.com/dotnet/csharp/language-reference/operators/patterns) — C# reference: property, positional, relational, logical and list patterns.
- [Pattern matching overview](https://learn.microsoft.com/dotnet/csharp/fundamentals/functional/pattern-matching) — when to use each kind of pattern.
- [using statement](https://learn.microsoft.com/dotnet/csharp/language-reference/statements/using) — `using` statements and `using` declarations.
- [?? and ??= operators](https://learn.microsoft.com/dotnet/csharp/language-reference/operators/null-coalescing-operator) — null-coalescing and null-coalescing assignment.
- [Indices and ranges](https://learn.microsoft.com/dotnet/csharp/tutorials/ranges-indexes) — the `^` and `..` operators and the types that support them.
- [Records](https://learn.microsoft.com/dotnet/csharp/language-reference/builtin-types/record) — the `record` used in the property pattern sample.
