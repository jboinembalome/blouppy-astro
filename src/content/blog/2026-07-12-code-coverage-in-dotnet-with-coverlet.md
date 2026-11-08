---
templateKey: 'blog-post'
title: 'Code coverage in .NET with coverlet, and what the number does not say'
date: 2026-07-12T09:00:00.000Z
author: Jimmy Boinembalome
authorimage: /img/jimmy.jpg
category: C#
topic: 'Testing'
illustration: 3
categorycolor: bg-purple-100 text-purple-800
featuredpost: true
description: >-
  Learn how to collect code coverage in .NET 10 with coverlet or Microsoft.Testing.Platform, merge it with ReportGenerator, show it in a pull request, and read what the number hides.
tags:
  - Development
  - C#
  - Testing
  - GitHub Actions
---

Most .NET test projects created from a template reference `coverlet.collector`. Few of them ever produce a coverage report, and the ones that do often show a single percentage on a badge that nobody reads twice. When somebody does read it, the question is usually the wrong one: "is 80% enough?".

In this article, we will collect coverage for a .NET 10 solution, with coverlet on VSTest and with the code coverage extension of Microsoft.Testing.Platform, merge the reports of many test projects with ReportGenerator, show the result in a GitHub Actions summary, and look at what the number measures. It measures which lines ran. It does not measure what the tests checked.


## Two runners, two ways to collect
Since .NET 10, `dotnet test` runs on one of two platforms, and the coverage tool depends on which one.

With **VSTest**, the historical runner, coverage is a *data collector*. The `coverlet.collector` package plugs into it, and the `--collect` switch turns it on:

```bash
dotnet test --collect "XPlat Code Coverage"
```

Each test project writes a `coverage.cobertura.xml` under its `TestResults` folder.

With **Microsoft.Testing.Platform** (MTP), the test project is an executable that runs its own tests, and VSTest data collectors are not loaded. Coverage comes from an MTP extension instead, `Microsoft.Testing.Extensions.CodeCoverage`, Microsoft's own coverage engine. Coverlet also ships an MTP flavour, `coverlet.MTP`, as a separate package. Once the extension is referenced, coverage is an option of the test run:

```bash
dotnet test -- --coverage --coverage-output-format cobertura
```

A solution opts into MTP in its `global.json`:

```json
{
  "test": {
    "runner": "Microsoft.Testing.Platform"
  }
}
```

The two worlds do not mix. An MTP test application rejects options it does not know, so `--collect` fails the run instead of being ignored.


## What the Starter actually has
[Blouppy Starter](https://starter.blouppy.com/) is a good example of the trap, because it sits exactly between the two. Its `back/global.json` selects Microsoft.Testing.Platform, and its CI runs the tests with an xUnit v3 option that only exists on MTP:

```yaml
- name: Test 🧪
  run: dotnet test --no-build --configuration Release -- --report-xunit-trx --results-directory "${{ github.workspace }}/back/TestResults"
  working-directory: back
```

At the same time, `Directory.Packages.props` pins `coverlet.collector` (10.1.0), and every one of the 39 test projects references it, the way the project template left it:

```xml
<PackageReference Include="coverlet.collector">
  <IncludeAssets>runtime; build; native; contentfiles; analyzers; buildtransitive</IncludeAssets>
  <PrivateAssets>all</PrivateAssets>
</PackageReference>
```

There is no `.runsettings` file, no coverage step in `.github/workflows/build.yml`, and nothing that uploads a report. So the Starter does **not** collect coverage today, and the collector it references cannot run on the platform it uses. Running one test project with `--collect "XPlat Code Coverage"` stops with `error: unknown option: --collect` and zero tests run.

Nobody asks for coverage, so nothing breaks. The reference still suggests that something is measured when nothing is. Either remove it or replace it with something that works. The rest of the article is a suggestion for the second option.


## Adding coverage to an MTP solution
Every test project needs the extension, because an MTP run that passes `--coverage` to a project without it fails on the unknown option. Rather than editing 39 project files, `back/Directory.Build.props` can add it to anything that declares itself a test project:

```xml
<ItemGroup Condition="'$(IsTestProject)' == 'true'">
  <PackageReference Include="Microsoft.Testing.Extensions.CodeCoverage" />
</ItemGroup>
```

The condition works even though `IsTestProject` is set in each `.csproj`: MSBuild evaluates every property before any item. The version goes in `Directory.Packages.props`, beside the others, and the `coverlet.collector` references can go.

The CI step then asks for a Cobertura file per project, in the same folder as the TRX files it already uploads:

```yaml
- name: Test 🧪
  run: >-
    dotnet test --no-build --configuration Release --
    --report-xunit-trx
    --coverage --coverage-output-format cobertura
    --results-directory "${{ github.workspace }}/back/TestResults"
  working-directory: back
```

Locally, on the Starter's `Blouppy.Webhooks.Models.UnitTests`, this writes one `<guid>.cobertura.xml` beside the TRX file. The test assembly itself is left out of the report, but a shared helper library such as `Blouppy.Shared.TestHelpers` is not, which matters for the next step.


## Merging the reports with ReportGenerator
One file per test project is not a report. The same assembly shows up in many of them: `Blouppy.SharedKernel` is loaded by almost every test project, each covering a different part of it. [ReportGenerator](https://reportgenerator.io/) reads all the files, merges the hits per line, and writes the formats we ask for:

```yaml
- name: Coverage report 📊
  if: always()
  run: |
    dotnet tool install --global dotnet-reportgenerator-globaltool
    reportgenerator \
      -reports:"TestResults/*.cobertura.xml" \
      -targetdir:"TestResults/coverage" \
      -reporttypes:"Html;MarkdownSummaryGithub;JsonSummary" \
      -assemblyfilters:"-*.TestHelpers" \
      -filefilters:"-*/Migrations/*"
    cat TestResults/coverage/SummaryGithub.md >> "$GITHUB_STEP_SUMMARY"
  working-directory: back
```

`MarkdownSummaryGithub` writes `SummaryGithub.md`, a table shaped for the [job summary](https://docs.github.com/actions/writing-workflows/choosing-what-your-workflow-does/workflow-commands-for-github-actions#adding-a-job-summary) of the run: line coverage, branch coverage, then one row per assembly and class. Appending it to `$GITHUB_STEP_SUMMARY` puts it on the run's page, one click from the pull request, with no third-party service and no token. The HTML report lands in `TestResults`, so the existing upload step keeps it with the TRX files for 14 days.

To get the number into the pull request conversation itself, the same Markdown file can be posted as a comment by an action such as `marocchino/sticky-pull-request-comment`. That needs `pull-requests: write` on the job, which is a permission worth weighing for a number.


## Line coverage and branch coverage
A coverage report gives two figures, and the second is the more honest one. Line coverage counts the lines that ran at least once. Branch coverage counts, at each decision, the outcomes that were taken.

`WebhookRules.UrlWithoutSecrets` in the Starter strips the user-info, query string and fragment from a URL before the audit log keeps it:

```csharp
public static string UrlWithoutSecrets(string url)
{
    ArgumentNullException.ThrowIfNull(url);

    if (Uri.TryCreate(url, UriKind.Absolute, out var uri))
    {
        return uri.GetComponents(
            UriComponents.Scheme | UriComponents.Host | UriComponents.Port | UriComponents.Path,
            UriFormat.UriEscaped);
    }

    var end = url.IndexOfAny(['?', '#']);

    return end < 0 ? url : url[..end];
}
```

Its test is a theory with five absolute URLs. On that project, the method reports **80% of lines and 25% of branches**. Every input parses, so the fallback for a string that is not an absolute URL never runs: two lines out of ten, but three of the four branch outcomes. The line figure says "nearly done"; the branch figure says that half of the method's behaviour was never tried. One `[InlineData]` with a relative path would close it.

Branches also hide in places a line count flattens: `??`, `?.`, a `switch` expression and a short-circuit `&&` all sit on one line and can be half-tested.


## Excluding what is not ours
A number is only useful if it counts code we wrote and are expected to test. Two kinds of code distort it.

**Generated code.** EF Core migrations are the big one in the Starter. Their files start with `// <auto-generated />`, but that comment is not an attribute, so the classes are instrumented like any other. Worse, `Blouppy.Infrastructure.Database.IntegrationTests` applies every migration in its fixture, so thousands of lines of `CreateTable` calls count as covered and lift the total while proving nothing. The `-filefilters:"-*/Migrations/*"` above removes them from the report. The same goes for test helpers, removed with `-assemblyfilters`.

**Code that is not unit tested on purpose**, such as a class that only wires the host. In a generic example: `[ExcludeFromCodeCoverage]` from `System.Diagnostics.CodeAnalysis` takes a type or a member out, and both coverlet and Microsoft's engine honour it:

```csharp
[ExcludeFromCodeCoverage(Justification = "Composition root, covered by the end-to-end suite.")]
internal static class HostBuilderExtensions
{
    // ...
}
```

Keep the attribute rare and always give the justification. An attribute that hides a hard class is the cheapest way to raise a number.


## Thresholds: pros and cons
The tempting next step is to fail the build under a percentage. With the `JsonSummary` report, it is a few lines of shell:

```yaml
- name: Coverage threshold 🚦
  run: |
    branch=$(jq '.summary.branchcoverage' TestResults/coverage/Summary.json)
    echo "Branch coverage: $branch%"
    awk -v b="$branch" 'BEGIN { exit (b < 60) }'
  working-directory: back
```

**For** a threshold: it stops a large untested feature from landing silently, and a floor that only moves up (a ratchet) records progress without arguing about the ideal value.

**Against** it: a global percentage moves for reasons unrelated to the change. Deleting well-tested code lowers it, adding a migration raises it. A developer blocked at 59.8% will write the test that runs the most lines, which is rarely the test that checks the most behaviour. And the threshold says nothing about *which* code is untested: 70% with the billing rules uncovered is worse than 60% with only the logging uncovered.

A reasonable middle ground is to show the number on every pull request, look at the uncovered lines of the files the change touches, and keep a hard threshold only on a small, critical assembly, if at all.


## What the number does not say
Coverage records that a line was executed during a test. It does not record that anything was checked. This test gives `UrlWithoutSecrets` exactly the same 80% as the real one:

```csharp
[Theory]
[InlineData("https://hooks.example.com/blouppy?token=s3cr3t")]
public void Should_keep_only_scheme_host_port_and_path_when_the_url_is_made_safe_for_the_audit_log(string url)
{
    // Act
    WebhookRules.UrlWithoutSecrets(url);
}
```

No assertion, a green test, the same coverage. If the method returned the URL untouched, token included, it would stay green. The same happens, less visibly, with a test that asserts on the wrong thing, or with a mock set up but never verified.

So coverage is good at one job: finding code that **no test runs at all**. That is a certain gap. A covered line is only a possible check. The complement is mutation testing, where a tool such as Stryker.NET changes the code and reports the mutations that no test noticed.


## When it is not worth the trouble
For a small project with a handful of focused tests, a coverage pipeline is overhead: running the tests with `--coverage` locally, once in a while, and opening the HTML report is enough. The same holds when most of the value sits in integration and end-to-end tests whose coverage mostly measures how much of the framework ran. Coverage earns its CI step on a codebase with many contributors, where "did anyone test this new service at all?" is a real question in review.

Whatever we choose, the Starter's case is worth avoiding: a package that suggests coverage is measured, on a platform where it cannot run.


## Conclusion
On .NET 10, the first question is which test platform runs the tests: `coverlet.collector` with `--collect` on VSTest, `Microsoft.Testing.Extensions.CodeCoverage` (or `coverlet.MTP`) with `--coverage` on Microsoft.Testing.Platform. ReportGenerator merges the per-project files, filters out migrations and helpers, and writes a summary GitHub Actions can show on the run. Read the branch figure before the line figure, treat uncovered code as a certain gap and covered code as an open question, and be careful with thresholds that reward running lines over checking them. If the architecture rules of a solution are already enforced by tests, as in [Architecture tests that fail the build](/blog/2026-07-03-architecture-tests-that-fail-the-build/), coverage is a useful light on the rest, and only a light.


## References
- [Code coverage for unit testing](https://learn.microsoft.com/dotnet/core/testing/unit-testing-code-coverage) — coverlet and ReportGenerator with `dotnet test`.
- [Microsoft.Testing.Platform code coverage](https://learn.microsoft.com/dotnet/core/testing/microsoft-testing-platform-extensions-code-coverage) — the `--coverage` options and output formats.
- [Testing with dotnet test](https://learn.microsoft.com/dotnet/core/testing/unit-testing-with-dotnet-test) — the VSTest and Microsoft.Testing.Platform modes and the `global.json` switch.
- [coverlet](https://github.com/coverlet-coverage/coverlet) — the collector, MSBuild and MTP integrations.
- [ReportGenerator](https://reportgenerator.io/usage) — report types, assembly, class and file filters.
- [ExcludeFromCodeCoverageAttribute](https://learn.microsoft.com/dotnet/api/system.diagnostics.codeanalysis.excludefromcodecoverageattribute) — excluding a type or member, with a justification.
- [Adding a job summary](https://docs.github.com/actions/writing-workflows/choosing-what-your-workflow-does/workflow-commands-for-github-actions#adding-a-job-summary) — writing Markdown to `$GITHUB_STEP_SUMMARY`.
