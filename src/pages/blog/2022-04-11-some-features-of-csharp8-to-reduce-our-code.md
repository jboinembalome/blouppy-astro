---
templateKey: 'blog-post'
title: 'Some features of C# 8.0 to reduce our code'
date: 2022-04-11T17:28:10.000Z
author: Jimmy Boinembalome
authorimage: /img/jimmy.jpg
category: C#
categorycolor: bg-purple-100 text-purple-800
featuredpost: true
featuredimage: /img/some-features-of-csharp8-to-reduce-our-code.jpg
description: >-
  Let's discover some features and improvements that appeared with the 8th version of the C# language.
tags:
  - Development
  - C#
  - Features
---

C# 8.0 was released in September 2019 at the same time as .NET Core 3.0.
In this article, we will look at some examples of features that can reduce the size of our code and/or make it more readable. Of course, the features of C# 8.0 are applicable in higher versions.


## Switch expression
The `switch expression` is a new way of writing a `switch statement`. It avoids writing the words `case` and `break` which can be redundant when we have several cases to consider.

Traditional way:

```csharp
public static string DoYouLikeCSharp8(bool? answer)
{
    switch (answer)
    {
        case true:
            return "It's fun! 😃";
        case false:
            return "The next versions will satisfy you better! 🙏";
        default:
            return "Oh... 😢 Do you prefer another language? 😇";
    };
}
```

Now let's reproduce the same code with the `switch expression`.

New way:

```csharp
public static string DoYouLikeCSharp8(bool? answer)
{
    return answer switch
    {
        true  => "It's fun! 😃",
        false => "The next versions will satisfy you better! 🙏",
        _     => "Oh... 😢 Do you prefer another language? 😇"
    };
}
```

## Property and Tuple patterns
### Property pattern
The property model allows us to establish cases of a `switch expression` by taking into consideration the properties of an object.

```csharp
public enum Level
{
    Notion,
    Practice,
    Autonomous,
    Expert
}
```

```csharp
public class Language
{
    public string Name { get; set; }

    public Level Level { get; set; }

    public Language(string name, Level level)
    {
        Name = name;
        Level = level;
    }
}
```


Traditional way:

```csharp
public static string GetLevelMessage(Language language)
{
    if (language.Level == Level.Notion && language.Name == "C#")
        return $"You are some notions in C#! 👍";
    else if (language.Level == Level.Practice && language.Name == "C#")
        return $"You practice the C#! 💪";
    else if(language.Level == Level.Autonomous && language.Name == "C#")
        return $"You are automomous in C#! 🤘";
    else if(language.Level == Level.Expert && language.Name == "C#")
        return $"You are an expert in C#! 👏";
    else 
        return $"I don't know what your level in {language.Name} is but I'm sure you are good! 😌";
}
```

In this example, we return a message according to the level and the name of the language. This implies to have a succession of if/else if. (Only for illustration, it is possible to use another way like the Factory Pattern as well)

With the property pattern, we can improve our code by using a `switch expression`.

New way:

```csharp
public static string GetLevelMessage(Language language)
{
    return language switch
    {
        { Level: Level.Notion, Name: "C#" } => $"You are some notions in C#! 👍",
        { Level: Level.Practice, Name: "C#" } => $"You practice the C#! 💪",
        { Level: Level.Autonomous, Name: "C#" } => $"You are automomous in C#! 🤘",
        { Level: Level.Expert, Name: "C#" } => $"You are an expert in C#! 👏",
        _ => $"I don't know what your level in {language.Name} is but I'm sure you are good! 😌"
    };
}
```

### Tuple pattern
Like the property pattern, we can apply a `switch expression` based on a tuple pattern:

```csharp
public static string GetLevelMessage(Level level, string language)
{
    return (level, language) switch
    {
        (level: Level.Notion, language: "C#") => $"You are some notions in {language}! 👍",
        (level: Level.Practice, language: "C#") => $"You practice the {language}! 💪",
        (level: Level.Autonomous, language: "C#") => $"You are automomous in {language}! 🤘",
        (level: Level.Expert, language: "C#") => $"You are an expert in {language}! 👏",
        _ => $"I don't know what your level in {language} is but I'm sure you are good! 😌"
    };
}
```

## Using declaration
Sometimes in C# it can be useful to dispose an object. For example, this is necessary when we read a text file with `StreamReader` or when we open a SQL connection with `SqlConnection`.

The `using statement` allows us to define a limit for the object outside of which, the object is automatically destroyed. This makes our code more elegant and avoids calling the dispose method in a try/catch. 

Traditional way:

```csharp
public static void ReadFile(string path)
{
    using (var streamReader = new StreamReader(path))
    {
        string line;
        // Read and display lines from the file until the
        // end of the file is reached.
        while ((line = streamReader.ReadLine()) != null)
            Console.WriteLine(line);
    } // file is disposed here
}
```

Since C# 8.0, it is possible to make a `using declaration`. This indicates to the compiler that the variable with the `using` keyword should be disposed at the end of the scope.

New way:

```csharp
public static void ReadFile(string path)
{
    using var streamReader = new StreamReader(path);
    string line;
    // Read and display lines from the file until the
    // end of the file is reached.
    while ((line = streamReader.ReadLine()) != null)
        Console.WriteLine(line);
} // file is disposed here
```

## Null-coalescing assignment
As we know, the null coalescence operator `??` returns the value of the left side if it is not null. Otherwise, it returns the value of the right side:

```csharp
string message = null;
message = message ?? "Default message";
```

Here `message` equals to **"Default message"** because `message` was null before.

With the null-coalescing assignment, we can simplify the second line like this:

```csharp
string message = null;
message ??= "Default message";
```

## Indices and ranges
Indices and ranges provide an elegant syntax for accessing single elements or ranges in a sequence of elements.

To see this, let's create an array of elements:
```csharp
var emojis = new string[]
{
    "🙂","☹️", "👍", "👎",
    "🐶", "🐱", "🍎", "🍐"
};
```

### Indices
The `^` operator allows us to use the index from end:

```csharp
var lastEmoji = emojis[^1]; // emojis[emojis.Length - 1]
var secondLastEmoji = emojis[^2]; // emojis[emojis.Length - 2]
var thirdLastEmoji = emojis[^3]; // emojis[emojis.Length - 3]
```

### Ranges

About ranges, there also is new operator `..` which specifies the start and end of a range:

```csharp
var smileys = emojis[0..2]; // emojis.Take(2)
var gestures = emojis[2..4]; // emojis.Skip(2).Take(2)
var animals = emojis[4..6]; // emojis.Skip(4).Take(2)
var fruits = emojis[6..8]; // emojis.Skip(6).Take(2)
```

## Conclusion
With C# 8.0, programming may not be as easy to understand if you are not familiar with the new features. However, once learned, it becomes a real advantage for all those who know it with its shorter and more elegant syntax.

I hope you enjoyed reading this article! 👍

If you want to know more about the features of C# 8.0, here is a link from the Microsoft docs:
- [What's new in C# 8.0](https://docs.microsoft.com/en-gb/dotnet/csharp/whats-new/csharp-8#more-patterns-in-more-places)