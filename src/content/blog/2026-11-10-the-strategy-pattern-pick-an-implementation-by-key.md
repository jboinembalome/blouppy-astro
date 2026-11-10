---
templateKey: 'blog-post'
title: 'The Strategy pattern in C#: pick an implementation by key with dependency injection'
date: 2026-11-10T10:00:00.000Z
author: Jimmy Boinembalome
authorimage: /img/jimmy.jpg
category: C#
topic: 'Architecture'
illustration: 3
categorycolor: bg-purple-100 text-purple-800
featuredpost: true
description: >-
  The usual shape of the Strategy pattern in .NET: one class per variant, a discriminant, IEnumerable injection, what to do when no strategy matches, and keyed services.
tags:
  - Development
  - C#
  - Design Patterns
---

A report can be downloaded as CSV, Excel or PDF. The first version is one method with a `switch` on the format:

```csharp
public byte[] Export(Report report, ExportFormat format)
    => format switch
    {
        ExportFormat.Csv => WriteCsv(report),
        ExportFormat.Excel => WriteExcel(report),
        ExportFormat.Pdf => WritePdf(report),
        _ => throw new NotSupportedException($"No exporter for {format}.")
    };
```

It reads well with three short branches. Then each format grows: Excel needs a spreadsheet library and a template, PDF needs a rendering library and fonts. The class that holds the `switch` now depends on every library of every format, and each new format means editing it again.

The Strategy pattern gives each format a class of its own, and lets the caller pick one by key.


## One class per format
Each format implements one interface. The interface also says which format it handles: that property is the **discriminant** the caller will use to choose.

```csharp
public enum ExportFormat
{
    Csv,
    Excel,
    Pdf
}

public interface IReportExporter
{
    ExportFormat Format { get; }

    byte[] Export(Report report);
}

internal sealed class CsvReportExporter : IReportExporter
{
    public ExportFormat Format => ExportFormat.Csv;

    public byte[] Export(Report report)
        => Encoding.UTF8.GetBytes(string.Join('\n', report.Rows.Select(row => string.Join(',', row))));
}

internal sealed class PdfReportExporter(IPdfRenderer renderer) : IReportExporter
{
    public ExportFormat Format => ExportFormat.Pdf;

    public byte[] Export(Report report)
        => renderer.Render(report);
}
```

The CSV exporter needs nothing; the PDF exporter needs a renderer. Each class injects only what its own format needs, so a test of the CSV output sets up no mock at all.


## Picking one by key
Every exporter is registered against the same interface. Asked for `IEnumerable<IReportExporter>`, the container returns all of them, and the service, the **context** of the pattern, picks the one whose format matches:

```csharp
services
    .AddScoped<IReportExporter, CsvReportExporter>()
    .AddScoped<IReportExporter, ExcelReportExporter>()
    .AddScoped<IReportExporter, PdfReportExporter>()
    .AddScoped<IReportExportService, ReportExportService>();

public interface IReportExportService
{
    byte[] Export(Report report, ExportFormat format);
}

internal sealed class ReportExportService(IEnumerable<IReportExporter> exporters) : IReportExportService
{
    private readonly Dictionary<ExportFormat, IReportExporter> _byFormat =
        exporters.ToDictionary(x => x.Format);

    public byte[] Export(Report report, ExportFormat format)
        => _byFormat.TryGetValue(format, out var exporter)
            ? exporter.Export(report)
            : throw new NotSupportedException($"No exporter for {format}.");
}
```

Adding a format is a new value in the enum, a new class and a registration line; `ReportExportService` does not change, and its callers only know `IReportExportService`. The strategies and the service are scoped: a strategy can then take any dependency, a `DbContext` included, and the service never holds one beyond its request (see [the captive dependency](/blog/2026-05-07-dotnet-di-lifetimes-and-the-captive-dependency/)). Three details are worth keeping:

- **`ToDictionary` throws on a duplicate key.** Two classes claiming `Pdf` fail as soon as the service is built, instead of one being silently ignored.
- **What happens when no strategy matches is a decision.** Here an exception is right: a format without an exporter is a bug. [Blouppy Starter](https://starter.blouppy.com/) makes the opposite choice for its real-time topics, where each kind of topic has an authorizer picked the same way: when no authorizer matches, the request is refused, so a kind whose authorizer was forgotten is closed rather than open. Silently doing nothing is rarely the right answer.
- **The discriminant does not have to be an enum.** A `string` works the same way when the key comes from outside, such as a file extension or a route value.


## Keyed services
Since .NET 8, the container can do the lookup itself. Each strategy is registered under its key with `AddKeyedScoped<IReportExporter, PdfReportExporter>(ExportFormat.Pdf)`, and resolved by that key with `GetRequiredKeyedService<IReportExporter>(format)`.

That saves the dictionary, but the key moves from the class to the registration, and a key known only at run time has to be resolved through `IServiceProvider`, which hides the dependency. Keyed services shine when the key is known at compile time and injected with `[FromKeyedServices(ExportFormat.Pdf)]`. For a key that arrives with the request, the `IEnumerable<>` and a discriminant keep each class explicit about what it handles.


## When a switch is enough
A class, a registration and a test per variant is real weight. When the variants are a few lines, need no dependency and are unlikely to grow, the `switch` above reads better. A strategy pays off when each variant has its own collaborators, its own edge cases and its own tests.

Not every Strategy picks one implementation, either. In an [issue activity log](/blog/2026-11-10-the-strategy-pattern-an-issue-activity-log/), every field has its own strategy and all of them run on each change, chosen by generic type rather than by key.


## References

- [Strategy](https://refactoring.guru/design-patterns/strategy) — Refactoring.Guru: the pattern's structure and trade-offs.
- [Dependency injection in .NET](https://learn.microsoft.com/dotnet/core/extensions/dependency-injection) — Microsoft Learn: several implementations of one service, and keyed services.
- [Replace Conditional with Polymorphism](https://refactoring.com/catalog/replaceConditionalWithPolymorphism.html) — Martin Fowler's refactoring that leads to the pattern.
- [Introduction to SOLID principles](/blog/2022-02-28-introduction-to-solid-principles/) — the open/closed principle behind the pattern.
