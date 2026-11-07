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
  Let's discover the nullable reference types in a C# project.
tags:
  - Development
  - C#
  - Features
---

> **Updated November 2026:** the samples now target .NET 10, where nullable reference types are on by default, and I added the tools we use every day with them: the `!` operator, the `#nullable` directive, the `[NotNullWhen]` attribute and turning the warnings into errors. 🙂

C# 8.0 adds a bunch of new [features](https://www.blouppy.com/blog/2022-04-11-some-features-of-csharp8-to-reduce-our-code/). In this article we will focus on the nullable reference types that you may find in some projects.

## Nullable reference type
When working with objects or values, we often manipulate values that are null at a given time. For `value` types, it is simply a matter of suffixing the type with the `?` to accept a null value:

```csharp
// Works
int? a = null;

// Get a CS0037 error: Cannot convert null to 'int' because it is a non-nullable value type
int b = null;
```

Regarding `reference` types, the addition of the `?` was not necessary since any `reference` type can be null. However, it often meant checking in our code whether the object is null or not before using it.

To better understand this, let's do an example:

```csharp
public static class StringExtensions
{
    public static int CountWords(this string text)
    {
        int wordCount = 0, index = 0;

        // Skip whitespace until first word
        while (index < text.Length && char.IsWhiteSpace(text[index]))
            index++;

        while (index < text.Length)
        {
            // Check if current char is part of a word
            while (index < text.Length && !char.IsWhiteSpace(text[index]))
                index++;

            wordCount++;

            // Skip whitespace until next word
            while (index < text.Length && char.IsWhiteSpace(text[index]))
                index++;
        }

        return wordCount;
    }
}
```
The above code provides an extension method to count the number of words in a string.

Next, we will use our new extension method in the top-level statements of `Program.cs`:

```csharp
string message = "WE LOVE C#!!! 😍";
int count = string.IsNullOrWhiteSpace(message) ? 0 : message.CountWords();

Console.WriteLine($"Count Words: {count}");
```

```bash:clipboard=false
Count Words: 4
```

As we can see from the second line, we need to check that `message` is not null before calling `CountWords`. This is necessary to avoid an error in the extension method which only works with non null values. (`CountWords` can be improved to take the null value as well, but that is not the topic of this article 👍)

To limit the risk of error about null references, we can configure our project to allow the compiler to check whether or not `reference` types are null in the same way as `value` types.

In the .csproj file, we can add a `Nullable` element:

```xml{5}
<PropertyGroup>
    <OutputType>Exe</OutputType>
    <TargetFramework>net10.0</TargetFramework>
    <ImplicitUsings>enable</ImplicitUsings>
    <Nullable>enable</Nullable>
</PropertyGroup>
```

> **_Note:_** Since .NET 6, the project templates (`dotnet new console`, `dotnet new webapi`…) already contain `<Nullable>enable</Nullable>`: a new project has nullable reference types turned on from the start. We only have to add it ourselves in older projects. (The element works since .NET Core 3.0 and C# 8.0.)

Now if we intentionally set the message variable to null, a warning message will appear:

```csharp
// Get a CS8600 warning: Converting null literal or possible null value
// to non-nullable type.
string message = null;
var count = string.IsNullOrWhiteSpace(message) ? 0 : message.CountWords();

Console.WriteLine($"Count Words: {count}");
```

```bash:clipboard=false
Program.cs(3,18): warning CS8600: Converting null literal or possible null value to non-nullable type.
```

To make a reference type accept a null value, a "?" must be added like this:

```csharp
string? message = null;
```

## Why no warning on `message.CountWords()`?
Good question! 😄 `message` can be null, yet the compiler says nothing about `message.CountWords()` on the same line. The reason is that the compiler follows the flow of our code, and `string.IsNullOrWhiteSpace` tells it something: its parameter is declared `[NotNullWhen(false)] string? value`. In other words, "if I return `false`, the value was not null". So in the `:` branch, the compiler knows that `message` is not null.

We can use the same attribute (from `System.Diagnostics.CodeAnalysis`) on our own methods:

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
    Console.WriteLine($"Count Words: {message.CountWords()}");
```

Without `[NotNullWhen(true)]`, the compiler cannot know what `HasWords` checks and warns us:

```bash:clipboard=false
Program.cs(3,39): warning CS8604: Possible null reference argument for parameter 'text' in 'int StringExtensions.CountWords(string text)'.
```

There are other attributes of the same family, like `[NotNull]`, `[MaybeNullWhen]` or `[MemberNotNull]`, for the other situations.

## The null-forgiving operator `!`
Sometimes we know better than the compiler. For example, `Console.ReadLine()` returns a `string?` because it returns null when there is nothing left to read. In a small tool that always reads from the keyboard, we can tell the compiler "trust me, it is not null" with the `!` operator:

```csharp
string input = Console.ReadLine()!;
Console.WriteLine($"Count Words: {input.CountWords()}");
```

The `!` only removes the warning: nothing is checked at runtime, so if we are wrong, we get our good old `NullReferenceException`. Use it sparingly! 😅

## The `#nullable` directive
On a big existing project, enabling nullable reference types everywhere at once can bring hundreds of warnings. The `#nullable` directive lets us change the setting for a part of a file, and migrate step by step:

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
    public string Name { get; set; }
}
```

`#nullable restore` goes back to what the project says in its `.csproj`. We can also do the opposite: keep `<Nullable>disable</Nullable>` in the project and put `#nullable enable` at the top of each file we have migrated.

## Turning the warnings into errors
A warning is easy to ignore... To make sure no null problem gets in, we can ask the compiler to treat every nullable warning as an error, without touching the other warnings:

```xml{6}
<PropertyGroup>
    <OutputType>Exe</OutputType>
    <TargetFramework>net10.0</TargetFramework>
    <ImplicitUsings>enable</ImplicitUsings>
    <Nullable>enable</Nullable>
    <WarningsAsErrors>nullable</WarningsAsErrors>
</PropertyGroup>
```

Now the sample with `string message = null;` above no longer builds:

```bash:clipboard=false
Program.cs(3,18): error CS8600: Converting null literal or possible null value to non-nullable type.
```

## Conclusion
Seeing a `?` behind a reference type may seem confusing when we are not familiar with this feature that arrived with C# 8.0. Once known, enabling nullable reference types is a feature that can help us during development to limit null reference problems. And since .NET 6, it is even on by default!

What about you? Do you use nullable references? 🙂

If you want to know more about nullable reference types, here are three links from the Microsoft docs:
- [Nullable reference types](https://learn.microsoft.com/en-us/dotnet/csharp/fundamentals/null-safety/nullable-reference-types)
- [Attributes for null-state static analysis](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/attributes/nullable-analysis)
- [The null-forgiving operator `!`](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/operators/null-forgiving)