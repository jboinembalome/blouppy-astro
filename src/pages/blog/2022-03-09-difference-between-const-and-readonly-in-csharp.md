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
  Let's answer a common question that many C# developers ask themselves.
tags:
  - Development
  - C#
  - Const
  - Readonly
---

> **Updated November 2026:** I checked everything again on .NET 10 with two real projects, fixed the list of types a `const` accepts and a sample that no longer compiled, and switched to file-scoped namespaces and top-level statements. 🙂

When we develop, we may use variables that are not modifiable.
Sometimes we work with `const`, other times we use variables that are `readonly`.
However, what are the differences between these two keywords from a technical point of view?

## Const keyword
The `const` keyword is used to declare a variable that cannot be modified after it has been initialized.

Below is an example of a `const` declaration:

```csharp
public class Colour
{
    public const string ConstRed = "#FF0000";
}
```

- A `const` is implicitly `static`. This means that we can access `ConstRed` without creating a new instance of `Colour` (and we cannot add the `static` keyword ourselves: `error CS0504: The constant 'ConstRed' cannot be marked static`).
- A `const` can be declared in a method if needed (a local constant), unlike a `readonly`.
- A `const` only accepts the built-in numeric types (`int`, `double`, `decimal`…), `bool`, `char`, `string` and enums. Any other reference type can only be a `const` with the value `null`. Therefore, it is not possible to use a `const` for a `DateTime` (`error CS0283: The type 'DateTime' cannot be declared const`) or for any other struct: that's a job for `static readonly`.
- Since C# 10, a `const string` can be an interpolated string, as long as everything inside it is a constant string too:

```csharp
public class Colour
{
    public const string Hash = "#";
    public const string ConstRed = $"{Hash}FF0000";
}
```


## Readonly keyword
The `readonly` keyword is used to declare a variable which can only be initialized at the declaration time or in constructors.

Below is an example of a `readonly` declaration:

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

It is also possible to have a static field like this:

```csharp
public class Colour
{
    public static readonly string ReadOnlyRed = "#FF0000";
}
```

- A `readonly` variable can only be declared as a field. Therefore, it is not possible to have a `readonly` local variable inside a method (`error CS0106: The modifier 'readonly' is not valid for this item`).
- A `readonly` accepts both value types and reference types. It is possible to modify the properties of an object that is in a `readonly` field, but we cannot replace the object with another.


## Significant difference

A `const` is a compile time constant that is copied into every assembly that uses it, as opposed to a `readonly` which is a value at runtime. 

Let's take an example to understand this better.

Below we have a `Colour` class present in the Core DLL (a class library project) which is referenced by several applications.

```csharp
namespace Core;

public class Colour
{
    public const string ConstRed = "#FF0000";
    public static readonly string ReadOnlyRed = "#FF0000";
}
```

As we can see, the `Colour` class has a `const` and a `readonly` with the same value. 

Now let's look at the code of an application (`SampleConstVsReadonly`, a console project with a reference to Core) that uses the Core DLL. With top-level statements, its whole `Program.cs` is:

```csharp
using Core;

Console.WriteLine($"Const value: {Colour.ConstRed}.");
Console.WriteLine($"Readonly value: {Colour.ReadOnlyRed}.");
```

Once the application is compiled and run, we get the following result:

```bash:clipboard=false
Const value: #FF0000.
Readonly value: #FF0000.
```

Unfortunately, we are not satisfied with the red colour... As a result, we decide to modify the code of the `Colour` class which is in the DLL.

```csharp
namespace Core;

public class Colour
{
    public const string ConstRed = "#EF4444";
    public static readonly string ReadOnlyRed = "#EF4444";
}
```

Now we compile the updated DLL. Since we haven't changed anything in the application, we simply replace the old DLL with the newer one without recompiling the application:

```bash
dotnet build Core
cp Core/bin/Debug/net10.0/Core.dll App/bin/Debug/net10.0/Core.dll
```

Next we restart the application to see the result:

```bash
dotnet App/bin/Debug/net10.0/SampleConstVsReadonly.dll
```

```bash:clipboard=false
Const value: #FF0000.
Readonly value: #EF4444.
```

And as we can see, only the readonly is updated.

The reason for this is that when the application is compiled, the compiler replaces the `const` with its value: `"#FF0000"` is written into the application's own DLL, and Core is not even asked for it.
However, the behaviour is different for `readonly` because the value is read from Core at runtime, so every time we run the application.

To solve the `const` problem, simply recompile the application with the new DLL (`dotnet build App`), and both lines show `#EF4444`.

That's why a public `const` should only hold values that will truly never change (like `Math.PI`). For a value that may change in a future version of a library, a `static readonly` field is the safer choice.

## Conclusion
The keywords `const` and `readonly` have some things in common but also some differences that can have an impact on our projects.
The `const` is a compile-time value and the `readonly` a runtime one.

If we want to update a constant that is in a DLL, 
we need to recompile all projects that reference that DLL to get the new value of the constant.

I hope I have helped you demystify the differences between `const` and `readonly`.
If not, I will be happy to exchange with you in comments! 👍

*Thanks for reading! 🙂*