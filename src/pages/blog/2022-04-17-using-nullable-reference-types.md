---
templateKey: 'blog-post'
title: 'Using nullable reference types in C# projects'
date: 2022-04-17T17:28:10.000Z
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

C# 8.0 adds a bunch of new [features](https://www.blouppy.com/blog/2022-04-11-some-features-of-csharp8-to-reduce-our-code/). In this article we will focus on the nullable reference types that you may find in some projects.

## Nullable reference type
When working with objects or values, we often manipulate values that are null at a given time. For `value` types, it is simply a matter of suffixing the type with the `?` to accept a null value:

```csharp
// Works
int? a = null; 

// Get a CS0037 error: Cannot convert null to 'int' 
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

Next, we will use our new extension method:

```csharp
static void Main(string[] args)
{
    string message = "WE LOVE C#!!! 😍";
    int count = string.IsNullOrWhiteSpace(message) ? 0 : message.CountWords();

    Console.WriteLine($"Count Words: {count}");
}
```
As we can see from the line 4, we need to check that `message` is not null before calling `CountWords`. This is necessary to avoid an error in the extension method which only works with non null values. (`CountWords` can be improved to take the null value as well, but that is not the topic of this article 👍)

To limit the risk of error about null references, we can configurecour project to allow the compiler to check whether or not `reference` types are null in the same way as `value` types.

In the .csproj file, we can add a `Nullable` element:

```xml{4}
<PropertyGroup>
    <OutputType>Exe</OutputType>
    <TargetFramework>net5.0</TargetFramework>
    <Nullable>enable</Nullable>
</PropertyGroup>
```

> **_Note:_**  The above project targets the net5.0 framework but it also works for netcoreapp 3.1.

Now if we intentionally set the message variable to null, a warning message will appear:

```csharp
static void Main(string[] args)
{
    // Get a CS8600 warning: Converting null literal or possible null value 
    // to non-nullable type
    string message = null;
    var count = string.IsNullOrWhiteSpace(message) ? 0 : message.CountWords();

    Console.WriteLine($"Count Words: {count}");
}
```

To make a reference type accept a null value, a "?" must be added like this:

```csharp
string? message = null;
```

## Conclusion
Seeing a `?` behind a reference type may seem confusing when we are not familiar with this feature that arrived with C# 8.0. Once known, enabling nullable type references is a feature that can help us during development to limit null reference problems. 

What about you? Do you use nullable references? 🙂

If you want to know more about the nullable reference type of C# 8.0, here is two links from the Microsoft docs:
- [What's new in C# 8.0 - Nullable reference types](https://docs.microsoft.com/en-gb/dotnet/csharp/whats-new/csharp-8#nullable-reference-types)
- [Nullable reference types](https://docs.microsoft.com/en-gb/dotnet/csharp/nullable-references)