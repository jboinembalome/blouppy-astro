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
  Learn how to write, run and read a BenchmarkDotNet benchmark in .NET 10, with parameters, setup and memory diagnostics.
tags:
  - Development
  - C#
  - Benchmark
---

> **Updated November 2026:** rewritten for .NET 10 and BenchmarkDotNet 0.15.8, with `[MemoryDiagnoser]` and freshly measured results. LINQ has become much faster since the first version of this article.

Benchmarking measures how fast code runs, so that you can compare implementations and find what is worth optimising. In this article, we create a benchmark in **C#** that compares three ways to find an element by its id in a list:
- a `foreach` loop,
- LINQ's [`FirstOrDefault()`](https://learn.microsoft.com/dotnet/api/system.linq.enumerable.firstordefault),
- LINQ's [`SingleOrDefault()`](https://learn.microsoft.com/dotnet/api/system.linq.enumerable.singleordefault).

## Prerequisites
- The [.NET 10 SDK](https://dotnet.microsoft.com/download/dotnet/10.0).
- An editor, for example [Visual Studio Code](https://code.visualstudio.com/) with the [C# extension](https://marketplace.visualstudio.com/items?itemName=ms-dotnettools.csharp).

## BenchmarkDotNet
[BenchmarkDotNet](https://benchmarkdotnet.org/) is an open-source library that turns methods into benchmarks. It handles warm-up, repeated measurements and statistics, and prints the results as a table. It supports .NET and .NET Framework.

## Create a new project
1. Create a folder named **IntroductionToBenchmarkDotNet** and open a terminal in it.
2. Create a console app ([`dotnet new`](https://learn.microsoft.com/dotnet/core/tools/dotnet-new)):
```powershell
dotnet new console --framework net10.0
```
3. Add the [BenchmarkDotNet](https://www.nuget.org/packages/BenchmarkDotNet/0.15.8) package:
```powershell
dotnet add package BenchmarkDotNet --version 0.15.8
```

## Create a benchmark

### Add a benchmark class
We need a `Person` class with an `Id` and a `Name`, and a `GetByIdBenchmark` class that holds a list of people:
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

This class uses three BenchmarkDotNet attributes:
- [`MemoryDiagnoser`](https://benchmarkdotnet.org/articles/configs/diagnosers.html) adds an **Allocated** column to the results: the managed memory allocated by a single call.
- [`Params`](https://benchmarkdotnet.org/articles/features/parameterization.html) takes a set of values. BenchmarkDotNet runs each benchmark once per value.
- The [`GlobalSetup`](https://benchmarkdotnet.org/articles/features/setup-and-cleanup.html) method runs **once per benchmark case** (a method combined with a parameter value), before the measurements start. It prepares the same data for every benchmark, and its own duration is not measured.

> **_Note:_** `GlobalCleanup` runs once after each benchmark case, for example to dispose a resource. `IterationSetup` runs before every iteration, but the documentation reserves it for macrobenchmarks, which take at least 100 ms.

### Add the methods to compare
Add the three lookups to `GetByIdBenchmark`. The `Benchmark` attribute marks each method to measure:

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

[Benchmark]
public Person? FirstOrDefault()
    => people.FirstOrDefault(x => x.Id == id);

[Benchmark]
public Person? SingleOrDefault()
    => people.SingleOrDefault(x => x.Id == id);
```

## Run the benchmark
[`BenchmarkRunner`](https://benchmarkdotnet.org/articles/overview.html) runs every benchmark in a class. Replace the content of **Program.cs**:

```csharp
using BenchmarkDotNet.Running;
using IntroductionToBenchmarkDotNet.Benchmarks;

BenchmarkRunner.Run<GetByIdBenchmark>();
```

Then run the project in Release mode:
```powershell
dotnet run -c Release
```

> **_Note:_** `-c` (`--configuration`) sets the build configuration, which defaults to Debug ([`dotnet run`](https://learn.microsoft.com/dotnet/core/tools/dotnet-run)). Always benchmark in Release: a Debug build is not optimised, so it measures code that never runs in production. BenchmarkDotNet refuses to run a non-optimised assembly by default.

The default job warms up and measures each case many times: the 9 cases took about 14 minutes on my 4-core Linux virtual machine. Your numbers depend on your hardware. Here are mine:

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

**Mean** is the arithmetic mean of all measurements, **Error** half of the 99.9% confidence interval, **StdDev** their standard deviation and **Median** the 50th percentile. **Allocated** is the managed memory allocated per operation (`-` means none), and 1 ns is 0.000000001 s.

What the **Mean** column tells us:
- `foreach` is the fastest, and `FirstOrDefault` is less than 1 ns behind. The list size does not matter for either, because the id we look for (`1`) is the first element, so both stop immediately.
- `SingleOrDefault` is the only one that grows with the list (about 6 ns for 10 elements, 48 ns for 100): it scans the **whole** list to check that the match is unique.
- None of the three methods allocates on .NET 10.

> **_Note:_** At 1 or 2 ns, measurements are noisy. On my virtual machine, BenchmarkDotNet warned about multimodal distributions and removed a few outliers. Do not base a decision on a gap of a fraction of a nanosecond.

When I first wrote this article with .NET 6, on another machine, `FirstOrDefault` took about 23 ns, roughly 20 times slower than `foreach`, and `SingleOrDefault` about 780 ns for 100 elements. LINQ has been optimised release after release (the .NET team describes each round in its yearly posts, such as [Performance Improvements in .NET 10](https://devblogs.microsoft.com/dotnet/performance-improvements-in-net-10/)), so my old advice to avoid LINQ here no longer holds. Use `FirstOrDefault` for the first match, `SingleOrDefault` only when you need the uniqueness check, and measure before you rewrite readable LINQ as a loop.

## Bonus: compare runtimes
A benchmark can run on several runtimes. To compare the two current LTS versions, .NET 8 and .NET 10, make the project [target both frameworks](https://learn.microsoft.com/dotnet/standard/frameworks) in the .csproj file. Replace:

```xml
<TargetFramework>net10.0</TargetFramework>
```
with:

```xml
<TargetFrameworks>net8.0;net10.0</TargetFrameworks>
```

Then add one [`SimpleJob`](https://benchmarkdotnet.org/articles/configs/jobs.html) attribute per runtime to `GetByIdBenchmark`:
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

> **_Note:_** Each runtime you benchmark must be installed. The .NET 10 moniker is `Net10_0`, not `Net100`.

Run the project with the host framework set:
```powershell
dotnet run -c Release --framework net10.0
```

`--framework net10.0` only selects the runtime that hosts the console app. BenchmarkDotNet still runs both jobs, and the summary gets a **Runtime** column to compare them.

> **_Note:_** Only .NET 10 was installed on my machine for this update: I checked that this project builds, but I did not run the .NET 8 job, so there is no comparison table here.

## Conclusion
**BenchmarkDotNet** measures your code and summarises the results in a readable table. It is the standard benchmarking library of the .NET ecosystem: the .NET team uses it in [dotnet/performance](https://github.com/dotnet/performance) for the runtime and libraries.

As the LINQ results show, a benchmark result does not last forever: run your benchmarks again when you upgrade .NET.

Source code of the article: [GitHub source code](https://github.com/jboinembalome/IntroductionToBenchmarkDotNet)

## References
- [BenchmarkDotNet documentation](https://benchmarkdotnet.org/) — the official documentation of the library.
- [BenchmarkDotNet: Setup and cleanup](https://benchmarkdotnet.org/articles/features/setup-and-cleanup.html) — `GlobalSetup`, `GlobalCleanup`, `IterationSetup` and when each runs.
- [BenchmarkDotNet: Parameterization](https://benchmarkdotnet.org/articles/features/parameterization.html) — `Params` and related attributes.
- [BenchmarkDotNet: Diagnosers](https://benchmarkdotnet.org/articles/configs/diagnosers.html) — `MemoryDiagnoser` and the Allocated column.
- [BenchmarkDotNet: Jobs](https://benchmarkdotnet.org/articles/configs/jobs.html) — `SimpleJob` and runtime monikers.
- [BenchmarkDotNet: Good practices](https://benchmarkdotnet.org/articles/guides/good-practices.html) — Release builds, noise and other pitfalls.
- [dotnet run](https://learn.microsoft.com/dotnet/core/tools/dotnet-run) — the `--configuration` and `--framework` options.
- [Target frameworks in SDK-style projects](https://learn.microsoft.com/dotnet/standard/frameworks) — `TargetFrameworks` and framework monikers.
- [Enumerable.FirstOrDefault](https://learn.microsoft.com/dotnet/api/system.linq.enumerable.firstordefault) and [Enumerable.SingleOrDefault](https://learn.microsoft.com/dotnet/api/system.linq.enumerable.singleordefault) — the two LINQ methods compared.
- [Performance Improvements in .NET 10](https://devblogs.microsoft.com/dotnet/performance-improvements-in-net-10/) — the .NET team's overview of this release's optimisations.
- [BenchmarkDotNet on NuGet](https://www.nuget.org/packages/BenchmarkDotNet/0.15.8) — the package used in this article.
- [dotnet/performance](https://github.com/dotnet/performance) — the .NET team's benchmarks, built on BenchmarkDotNet.
