---
templateKey: 'blog-post'
title: 'Introduction to BenchmarkDotNet'
date: 2022-10-22T18:24:10.000Z
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
  
Benchmarking is a process used to evaluate performance measures. We can take advantage of benchmarking to compare performance between different methods or libraries and determine which areas of our code can be optimized. 

In this article, we will create a benchmark in **C#** to compare the performance between 3 ways to retrieve a element by id in a object list:
- A `foreach` loop.
- The `FirstOrDefault()` extension. (Linq)
- The `SingleOrDefault()` extension. (Linq)


## Prerequisites
Before to start you will need:
- [Visual Studio Code](https://code.visualstudio.com/) with the [C# extension](https://marketplace.visualstudio.com/items?itemName=ms-dotnettools.csharp).
- The [.NET 6 SDK](https://dotnet.microsoft.com/download/dotnet/6.0).

> **_Note:_**  Of course, you can develop with your favourite IDE as well. 🙂


## BenchmarkDotNet
**BenchmarkDotNet** is an open source library that can quickly transform our methods into benchmarks. **BenchmarkDotNet** does most of the analysis of performance data for us and presents the results in a user-friendly format. In addition to being extremely powerful, **BenchmarkDotNet** is compatible with applications using the **.NET** and **.NET Core** frameworks.

Now we will install **BenchmarkDotNet**.


## Create a new project
1. Create a new folder named **IntroductionToBenchmarkDotNet**.
2. Open the created folder with **Visual Studio Code**.
3. Open a new **Terminal** in **Visual Studio Code**.
4. In the **Terminal**, run the following command to create a new **Console App** with **.Net 6**:
```powershell
dotnet new console --framework net6.0
```
5. Install the **BenchmarkDotNet** NuGet package with the following command:
```powershell
dotnet add package BenchmarkDotNet --version 0.13.2
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
namespace IntroductionToBenchmarkDotNet.Models 
{
    public class Person
    {
        public int Id { get; set; }
        public string Name { get; set; } = string.Empty;
    }
}
```

```csharp
using BenchmarkDotNet.Attributes;
using IntroductionToBenchmarkDotNet.Models;

namespace IntroductionToBenchmarkDotNet.Benchmarks
{
    public class GetByIdBenchmark
    {
        readonly List<Person> people = new();
        readonly int id = 1;

        [Params(10, 50, 100)]
        public int Iterations { get; set; }

        [GlobalSetup]
        public void GlobalSetup()
        {
            for (int i = 1; i <= Iterations; i++)
            {
                var person = new Person 
                { 
                    Id = i, 
                    Name = $"Name{i}" 
                };
                people.Add(person);
            }
        }
    }
}
```

Here we have used 2 attributes of **BenchmarkDotNet**, `Params` and `GlobalSetup`: 
- The `Params` attribute takes as a parameter a set of values. Each value passed as a parameter will be used in a benchmark.
- The `GlobalSetup` function allows us to perform an action before each benchmark. This is useful if we want to initialise a variable in the same way for each benchmark without duplicating code.

> **_Note:_** If needed, there is also a `GlobalCleanup` attribute to perform an action after each benchmark. E.g. To dispose an unmanaged resource.

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

> **_Note:_**  `-c` or `--configuration`, sets the build configuration. The default value is Debug. In the context of a benchmark, we use Release mode to improve the execution time of the benchmark, which can run 10 to 100 times slower in Debug mode.

If you did not get an error, you should get the result of the benchmarks according to your machine. 
For example, below is the result on my machine:

![Benchmark result](/img/introduction-to-benchmarkdotnet-benchmark-result.png)

Legends:
- Method: The method name executed
- Iterations: Value of the 'Iterations' parameter
- Mean: Arithmetic mean of all measurements (The average time)
- Error: Half of 99.9% confidence interval
- StdDev: Standard deviation of all measurements
- 1 ns: 1 Nanosecond (0.000000001 sec)

If we look at the **Mean** column in the image above, retrieving an object by its id seems to be faster with a `foreach` when our list has 10, 50 or 100 elements. From a technical point of view this makes sense:
- The `SingleOrDefault` method looks through the list to check if the item is unique.
- The `FirstOrDefault` method returns the first item found. 
- Concerning the performance difference between `FirstOrDefault` and `foreach`, `FirstOrDefault` is slower because the method creates and invokes a `delegate` which represents an additional cost.

## Bonus
We can also run our benchmarks on multiple frameworks. To do this we need to modify the .csproj file to allow the project to target multiple frameworks. 

For example, if we want to target the .NET 6.0 and .NET 7.0 frameworks we need to replace the line:

```xml{4}
<TargetFramework>net6.0</TargetFramework>
```
by:

```xml{4}
<TargetFrameworks>net6.0;net7.0</TargetFrameworks>
```

And add the `SimpleJob` attribute above the `GetByIdBenchmark` class:
```csharp
using BenchmarkDotNet.Attributes;
using BenchmarkDotNet.Jobs;
using IntroductionToBenchmarkDotNet.Models;

namespace IntroductionToBenchmarkDotNet.Benchmarks
{

    [SimpleJob(RuntimeMoniker.Net70)]
    [SimpleJob(RuntimeMoniker.Net60)]
    public class GetByIdBenchmark
    ...
}
```

> **_Note:_**  You must also install the SDK if it is not already installed.


After updating your project, you can run it a second time in release mode with the command:
```powershell
dotnet run -c Release --framework .net7.0
```
> **_Note:_**  This time we added the --framework .net7.0 parameter to host the console application with the .NET 7.0 framework. However, the application will run benchmarks for both frameworks. 😉


Below is the result on my machine:
![Benchmark result](/img/introduction-to-benchmarkdotnet-benchmark-result2.png)

## Conclusion
**BenchmarkDotNet** is a package that allows us to easily measure the performance of our code and observe the results with a user-friendly interface. Over 11,000 projects use BenchmarkDotNet, including dotnet/performance (benchmarks for all .NET runtimes), dotnet/runtime (.NET runtime and libraries), Roslyn (C# and Visual Basic compiler), ASP.NET Core, Entity Framework Core, Serilog, Avalonia, RestSharp, MediatR and many others.

During this article, you have had an introduction to the **BenchmarkDotNet** package. There are many other features offered by the package. If you want to know more, here is the link to the official documentation: [BenchmarkDotNet Doc](https://benchmarkdotnet.org/)

Source code of the article: [Github source code](https://github.com/jboinembalome/IntroductionToBenchmarkDotNet)

*Thanks for reading! 🙂*