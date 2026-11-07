---
templateKey: 'blog-post'
title: 'Introduction to BenchmarkDotNet'
date: 2022-10-22T18:24:10.000Z
updated: 2026-11-07T09:00:00.000Z
author: Jimmy Boinembalome
authorimage: /img/jimmy.jpg
category: C#
topic: 'Testing'
illustration: 1
categorycolor: bg-purple-100 text-purple-800
featuredpost: true
featuredimage: /img/introduction-to-benchmarkdotnet.jpg
description: >-
  Let's discover the BenchmarkDotNet package for tracking performance and sharing reproducible measurement experiments.
tags:
  - Development
  - C#
  - Benchmark
---

> **Updated November 2026:** rewritten for .NET 10 and BenchmarkDotNet 0.15.8, with `[MemoryDiagnoser]` and freshly measured results. Spoiler: LINQ got a lot faster since I first wrote this! 🚀

Benchmarking is a process used to evaluate performance measures. We can take advantage of benchmarking to compare performance between different methods or libraries and determine which areas of our code can be optimized. 

In this article, we will create a benchmark in **C#** to compare the performance between 3 ways to retrieve an element by id in an object list:
- A `foreach` loop.
- The `FirstOrDefault()` extension. (Linq)
- The `SingleOrDefault()` extension. (Linq)


## Prerequisites
Before to start you will need:
- [Visual Studio Code](https://code.visualstudio.com/) with the [C# extension](https://marketplace.visualstudio.com/items?itemName=ms-dotnettools.csharp).
- The [.NET 10 SDK](https://dotnet.microsoft.com/download/dotnet/10.0).

> **_Note:_**  Of course, you can develop with your favourite IDE as well. 🙂


## BenchmarkDotNet
**BenchmarkDotNet** is an open source library that can quickly transform our methods into benchmarks. **BenchmarkDotNet** does most of the analysis of performance data for us and presents the results in a user-friendly format. In addition to being extremely powerful, **BenchmarkDotNet** works with **.NET** (and the older **.NET Framework** and **.NET Core**).

Now we will install **BenchmarkDotNet**.


## Create a new project
1. Create a new folder named **IntroductionToBenchmarkDotNet**.
2. Open the created folder with **Visual Studio Code**.
3. Open a new **Terminal** in **Visual Studio Code**.
4. In the **Terminal**, run the following command to create a new **Console App** with **.NET 10**:
```powershell
dotnet new console --framework net10.0
```
5. Install the **BenchmarkDotNet** NuGet package with the following command:
```powershell
dotnet add package BenchmarkDotNet --version 0.15.8
```
6. Use the following command to **run** the app:
```powershell
dotnet run
```

If all the steps were successful, you should see on your terminal our fabulous:
```powershell:clipboard=false
Hello, World!
```

Now that we have successfully created our project and installed the **BenchmarkDotNet** package, we can create our first benchmark.


## Create a benchmark 

### Add a benchmark class
As we want to evaluate the performance of 3 ways to get an element by its id, we will add a `Person` class which will contain the properties `Id` and `Name` and a new class called `GetByIdBenchmark` with a list of people.
```csharp
namespace IntroductionToBenchmarkDotNet.Models;

public class Person
{
    public int Id { get; set; }
    public string Name { get; set; } = string.Empty;
}
```

```csharp
using BenchmarkDotNet.Attributes;
using IntroductionToBenchmarkDotNet.Models;

namespace IntroductionToBenchmarkDotNet.Benchmarks;

[MemoryDiagnoser]
public class GetByIdBenchmark
{
    readonly List<Person> people = [];
    readonly int id = 1;

    [Params(10, 50, 100)]
    public int Iterations { get; set; }

    [GlobalSetup]
    public void GlobalSetup()
    {
        for (int i = 1; i <= Iterations; i++)
        {
            var person = new Person { Id = i, Name = $"Name{i}" };
            people.Add(person);
        }
    }
}
```

Here we have used 3 attributes of **BenchmarkDotNet**, `MemoryDiagnoser`, `Params` and `GlobalSetup`:
- The `MemoryDiagnoser` attribute adds an **Allocated** column to the results: how much managed memory a single call allocates. Time is only half of the story! 😉
- The `Params` attribute takes as a parameter a set of values. Each value passed as a parameter will be used in a benchmark.
- The method marked with `GlobalSetup` runs **once per benchmark case** (a method combined with a parameter value), before its measurements start — not before every call. This is useful to initialise our data in the same way for each benchmark without duplicating code, and without measuring that setup.

> **_Note:_** If needed, there is also a `GlobalCleanup` attribute to perform an action once after each benchmark case. E.g. To dispose an unmanaged resource. And if you really need something to run before every single iteration, look at `IterationSetup` (with care, it is meant for benchmarks that take at least 100 ms).

### Add the methods to compare
Now let's add in the `GetByIdBenchmark` class, the 3 ways to get an element by its id.

- Foreach:
```csharp
[Benchmark]
public Person? Foreach()
{
    foreach (var person in people)
    {
        if (person.Id == id) 
            return person;
    }

    return null;
}
```

- FirstOrDefault:
```csharp
[Benchmark]
public Person? FirstOrDefault() 
    => people.FirstOrDefault(x => x.Id == id);
```

- SingleOrDefault:
```csharp
[Benchmark]
public Person? SingleOrDefault() 
    => people.SingleOrDefault(x => x.Id == id);
```

This time we have used the `Benchmark` attribute. `Benchmark` allows us to target the methods that will be run as a benchmark.


## Run the Benchmark 
We will use the `BenchmarkRunner` class to run all the benchmarks that are present in the `GetByIdBenchmark` class. To do this, let's update our **Program.cs** file:

```csharp
using BenchmarkDotNet.Running;
using IntroductionToBenchmarkDotNet.Benchmarks;

var summary = BenchmarkRunner.Run<GetByIdBenchmark>();
```

Finally, we will launch the project in release mode with the following command:
```powershell
dotnet run -c Release
```

> **_Note:_**  `-c` or `--configuration`, sets the build configuration. The default value is Debug. We always benchmark in Release mode: a Debug build is not optimised, so it measures code that will never run in production. BenchmarkDotNet even refuses to run benchmarks from a non-optimised assembly by default.

Be patient, with the default job each benchmark case is warmed up and measured many times (the 9 cases took about 14 minutes on my machine ☕). If you did not get an error, you should get the result of the benchmarks according to your machine.
For example, below is the result on my machine (a 4-core Linux virtual machine):

```text:clipboard=false
BenchmarkDotNet v0.15.8, Linux Ubuntu 24.04.5 LTS (Noble Numbat)
Intel Xeon Processor 2.10GHz, 1 CPU, 4 logical and 4 physical cores
.NET SDK 10.0.114
  [Host]     : .NET 10.0.14 (10.0.14, 10.0.1426.52326), X64 RyuJIT x86-64-v4
  DefaultJob : .NET 10.0.14 (10.0.14, 10.0.1426.52326), X64 RyuJIT x86-64-v4


| Method          | Iterations | Mean       | Error     | StdDev    | Median     | Allocated |
|---------------- |----------- |-----------:|----------:|----------:|-----------:|----------:|
| Foreach         | 10         |  1.1197 ns | 0.1330 ns | 0.3902 ns |  1.2465 ns |         - |
| FirstOrDefault  | 10         |  1.7252 ns | 0.1407 ns | 0.4105 ns |  1.7994 ns |         - |
| SingleOrDefault | 10         |  5.6789 ns | 0.2852 ns | 0.8408 ns |  5.9378 ns |         - |
| Foreach         | 50         |  0.8531 ns | 0.1090 ns | 0.3214 ns |  0.9066 ns |         - |
| FirstOrDefault  | 50         |  1.8664 ns | 0.1616 ns | 0.4766 ns |  1.9436 ns |         - |
| SingleOrDefault | 50         | 31.3460 ns | 1.1564 ns | 3.4096 ns | 32.2358 ns |         - |
| Foreach         | 100        |  1.0793 ns | 0.1008 ns | 0.2972 ns |  1.1098 ns |         - |
| FirstOrDefault  | 100        |  1.8025 ns | 0.1535 ns | 0.4526 ns |  1.9119 ns |         - |
| SingleOrDefault | 100        | 48.4199 ns | 1.5223 ns | 4.4885 ns | 50.2168 ns |         - |
```

Legends:
- Method: The method name executed
- Iterations: Value of the 'Iterations' parameter
- Mean: Arithmetic mean of all measurements (The average time)
- Error: Half of 99.9% confidence interval
- StdDev: Standard deviation of all measurements
- Median: Value separating the higher half of all measurements (50th percentile)
- Allocated: Allocated memory per single operation (managed only, `-` means nothing was allocated)
- 1 ns: 1 Nanosecond (0.000000001 sec)

If we look at the **Mean** column above, here is what the numbers tell us:
- `foreach` is still the fastest, but `FirstOrDefault` is now really close: less than 1 ns apart. In both cases the size of the list does not matter, because the id we are looking for (`1`) is the first element, so both stop right away.
- `SingleOrDefault` is the only one that grows with the list (about 6 ns for 10 elements, 48 ns for 100). This makes sense: it has to look through the **whole** list to check that the item is unique.
- None of the 3 methods allocates anything on .NET 10.

> **_Note:_** At this scale (1 or 2 ns), the measurements are noisy: BenchmarkDotNet printed warnings about multimodal distributions and removed a few outliers on my virtual machine. A gap of a fraction of a nanosecond is not something to build a decision on. 😉

When I first wrote this article with .NET 6 (on another machine, so the absolute numbers cannot be compared directly), `FirstOrDefault` took about 23 ns, roughly 20 times slower than the `foreach`, and `SingleOrDefault` about 780 ns for 100 elements. LINQ has been heavily optimised since then, especially for arrays and `List<T>`, so my old conclusion "avoid LINQ here, it is much slower" does not hold anymore. Use `FirstOrDefault` when you want the first match, `SingleOrDefault` only when you really need to check uniqueness (that check has a cost), and measure before rewriting readable LINQ into loops!

## Bonus
We can also run our benchmarks on multiple frameworks. To do this we need to modify the .csproj file to allow the project to target multiple frameworks. 

For example, if we want to compare the two current LTS versions, .NET 8 and .NET 10, we need to replace the line:

```xml{4}
<TargetFramework>net10.0</TargetFramework>
```
by:

```xml{4}
<TargetFrameworks>net8.0;net10.0</TargetFrameworks>
```

And add the `SimpleJob` attribute above the `GetByIdBenchmark` class:
```csharp
using BenchmarkDotNet.Attributes;
using BenchmarkDotNet.Jobs;
using IntroductionToBenchmarkDotNet.Models;

namespace IntroductionToBenchmarkDotNet.Benchmarks;

[MemoryDiagnoser]
[SimpleJob(RuntimeMoniker.Net10_0)]
[SimpleJob(RuntimeMoniker.Net80)]
public class GetByIdBenchmark
...
```

> **_Note:_**  You must also install each runtime you want to benchmark if it is not already installed. Also note the name of the moniker: since .NET 10 it is `Net10_0`, not `Net100`.


After updating your project, you can run it a second time in release mode with the command:
```powershell
dotnet run -c Release --framework net10.0
```
> **_Note:_**  This time we added the `--framework net10.0` parameter to host the console application with .NET 10. However, the application will run benchmarks for both frameworks, and the summary gets a **Runtime** column so you can compare them side by side. 😉

> **_Note:_**  For this update, only the .NET 10 runtime was installed on my machine, so I checked that this multi-targeted version builds, but I did not run the .NET 8 job and I have no comparison table to show you this time.

## Conclusion
**BenchmarkDotNet** is a package that allows us to easily measure the performance of our code and observe the results in a readable summary. It is the de facto benchmarking library of the .NET ecosystem: the .NET team itself uses it for the benchmarks of the runtime and libraries in [dotnet/performance](https://github.com/dotnet/performance).

And as we have seen with LINQ, a benchmark result is not true forever: when you upgrade .NET, run your benchmarks again! 🙂

During this article, you have had an introduction to the **BenchmarkDotNet** package. There are many other features offered by the package. If you want to know more, here is the link to the official documentation: [BenchmarkDotNet Doc](https://benchmarkdotnet.org/)

Source code of the article: [Github source code](https://github.com/jboinembalome/IntroductionToBenchmarkDotNet)

*Thanks for reading! 🙂*