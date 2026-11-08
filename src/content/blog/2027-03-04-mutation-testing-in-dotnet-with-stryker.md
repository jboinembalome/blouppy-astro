---
templateKey: 'blog-post'
title: 'Mutation testing in .NET with Stryker'
date: 2027-03-04T09:00:00.000Z
author: Jimmy Boinembalome
authorimage: /img/jimmy.jpg
category: C#
topic: 'Testing'
illustration: 2
categorycolor: bg-purple-100 text-purple-800
featuredpost: true
description: >-
  Learn what mutation testing measures that line coverage cannot, how to run Stryker.NET on one project with the Microsoft.Testing.Platform runner, and how to read its report.
tags:
  - Development
  - C#
  - Testing
  - xUnit
---

A method can be fully covered by green tests and still hide a bug the tests would never notice. Line coverage says that a line **ran** during the tests, not that any test would fail if that line were wrong: a test with no assertion covers as many lines as a test with ten.

Mutation testing answers the second question. It changes the production code in small ways, runs the tests against each change, and counts the changes that no test noticed.

In this article, we will see what a mutant is and the states it can end in, how the mutation score differs from line coverage, how to run Stryker.NET on one project (including with the Microsoft.Testing.Platform runner), how to read the report, and what it costs. The real example is a run on one model project of [Blouppy Starter](https://starter.blouppy.com/), with the real numbers.


## What a mutant is
A **mutant** is a copy of the code with one small change: `>=` becomes `>`, `&&` becomes `||`, a statement is removed, a string becomes `""`. Each kind of change is a **mutator**. Here is a rule and its tests:

```csharp
public static class Age
{
    public static bool IsAdult(int age)
        => age >= 18;
}

public sealed class AgeTests
{
    [Theory]
    [InlineData(30, true)]
    [InlineData(10, false)]
    public void Should_tell_an_adult_from_a_child(int age, bool expected)
    {
        // Act
        var isAdult = Age.IsAdult(age);

        // Assert
        isAdult.Should()
            .Be(expected);
    }
}
```

Coverage is 100%. Now replace `>=` with `>`: 30 is still an adult and 10 is still a child, so the tests stay green. The mutant **survived**, and it points at the missing case: 18.

Stryker.NET gives every mutant one of these states:

- **Killed**: at least one test failed. The tests detected the change.
- **Survived**: every test passed. The change went unnoticed.
- **No coverage**: no test even executes the mutated code.
- **Timeout**: the tests ran longer than the allowed time, usually because the mutant created an infinite loop. It counts as detected.
- **Compile error**: the mutant does not compile, so it is dropped.
- **Ignored**: excluded by configuration or by a filter.


## Mutation score versus line coverage
The **mutation score** is the share of valid mutants the tests detected:

```text
score = (killed + timeout) / (killed + timeout + survived + no coverage)
```

Compile errors and ignored mutants are left out. Thresholds colour the result: by default, 80% and above is good, below 60% is poor, and a `break` threshold makes the command return a non-zero exit code, which fails a CI job.

Line coverage is cheap and tells us which code no test reaches. The mutation score tells us, for the code the tests reach, whether they would notice a change. A high coverage with a low score is the signature of tests that execute code without checking what it does.


## Running it on one project
Stryker.NET is a .NET tool. A local tool keeps the version in the repository's tool manifest, so every developer and the CI run the same one:

```bash
dotnet new tool-manifest
dotnet tool install dotnet-stryker
```

It runs against **one project under test** and the test projects that reference it. From the test project's folder, it finds the project to mutate among the project references; `--project` picks one when there are several. From the source project's folder, `--test-project` names the tests instead:

```bash
cd Blouppy.Notifications.Models
dotnet stryker --test-project ../Blouppy.Notifications.Models.UnitTests/Blouppy.Notifications.Models.UnitTests.csproj
```

The options can live in a `stryker-config.json` next to where we run it:

```json
{
  "stryker-config": {
    "project": "Blouppy.Notifications.Models.csproj",
    "test-runner": "mtp",
    "reporters": [ "Html", "Json", "ClearText" ],
    "mutate": [ "**/Preferences/*.cs", "!**/NotificationChannelPreference.cs" ],
    "ignore-mutations": [ "string" ],
    "thresholds": { "high": 80, "low": 60, "break": 50 }
  }
}
```

`mutate` takes globs, with `!` to exclude a file, and narrows the run to the code that has rules worth testing. `ignore-mutations` removes a whole mutator; here the string mutator, which turns every message into `""`. Stryker writes its reports under `StrykerOutput/`, a folder to add to `.gitignore`.

### The test runner
The Starter's `back/global.json` sets the test runner of `dotnet test` to Microsoft.Testing.Platform:

```json
{
  "test": {
    "runner": "Microsoft.Testing.Platform"
  }
}
```

Stryker.NET 5.0.0, the version we used, defaults to VSTest and offers `--test-runner mtp`. On the Starter's xUnit v3 test project, the default runner did **not** work, and it failed quietly: Stryker logged that the coverage capture had failed, ran on, and reported every one of the 39 tested mutants as survived, for a score of 0%. With `"test-runner": "mtp"`, the same project gave the results below, along with a warning that the MTP runner is a preview and its results should be checked. So we checked one by hand, as the next section shows.

A score of 0%, or every mutant surviving, is the sign to look at the runner before looking at the tests.


## A real run on the Starter
We ran Stryker on `Blouppy.Notifications.Models`, the notifications' domain models: the notification itself, the reader's preferences per type and channel, and their quiet hours. The project has 28 tests. The whole run, build included, took about 16 seconds on a 4-core machine.

| Status | Mutants |
| --- | --- |
| Created | 50 |
| Compile error | 5 |
| Ignored | 6 |
| No coverage | 2 |
| Killed | 27 |
| Survived | 10 |

The score is 27 / (27 + 10 + 2), so **69.23%**. The ignored mutants were removed by Stryker's own optimisation, which skips a block-removal mutant when the statements of that block already carry mutants of their own. The five compile errors all come from one line of `NotificationPreferences`, where the mutated condition broke the pattern variables of `QuietHoursStart is { } start && QuietHoursEnd is { } end`, which the compiler no longer saw as definitely assigned.

The file to look at first was `QuietHours.cs`, at 82.35%. It is a small value object:

```csharp
namespace Blouppy.Notifications.Models.Preferences;

public sealed record QuietHours
{
    public QuietHours(TimeOnly start, TimeOnly end)
    {
        Exceptions.ThrowIf(
            start,
            value => value == end,
            "Quiet hours that start when they end describe either no time at all or every hour of the day.");

        Start = start;
        End = end;
    }

    public TimeOnly Start { get; }

    public TimeOnly End { get; }

    public bool Covers(TimeOnly localTime)
        => Start < End
            ? localTime >= Start && localTime < End
            // Wrapped: everything from the start to midnight, and from midnight to the end.
            : localTime >= Start || localTime < End;
}
```

The tests reach both branches of `Covers`: a window from 12:00 to 14:00 and a window from 22:00 to 07:00 wrapping around midnight. Every line runs. One surviving mutant was:

```csharp
? localTime > Start && localTime < End
```

The theory for the plain window checks 09:00, 12:30, 13:59 and 14:00, but never 12:00, the exact start. The wrapped window does check 22:00, which is why the same mutant on the other branch was killed. We applied the change by hand and ran `dotnet test`: 28 tests passed, so the report was right.

One more case kills it:

```csharp
[Theory]
[InlineData(9, 0, false)]
[InlineData(12, 0, true)]
[InlineData(12, 30, true)]
[InlineData(13, 59, true)]
[InlineData(14, 0, false)]
public void Should_cover_the_hours_between_the_start_and_the_end(int hour, int minute, bool expected)
```

The file went from 82.35% to 88.24%. The two mutants still alive there show the limits of the score:

- **The string mutant.** The message of the exception becomes `""`, and the test only checks that an `ArgumentException` is thrown. Whether a test should pin a message is a choice; it is a fair candidate for `ignore-mutations`.
- **An equivalent mutant.** `Start < End` becomes `Start <= End`. The constructor refuses a window that starts when it ends, so `Start == End` never happens and both versions behave the same. No test can kill it. An equivalent mutant is a false alarm, and only a person can recognise one.

The same report also flagged `Allows` in `NotificationPreferences`, where `preference.Type == type && preference.Channel == channel` survived as `||`, as did both `!=` variants: no test asks the lookup to tell apart two stored preferences that share a type or a channel.


## Reading the HTML report
The `Html` reporter writes a single file, `StrykerOutput/<date>/reports/mutation-report.html`, that opens in any browser. It starts with a tree of folders and files, each with its score and its counts per state, coloured by the thresholds. Opening a file shows its source with every mutant marked on its line; selecting one shows the replacement and its state, and the states can be filtered so that only the survivors remain.

The order that works for us: sort by score, open the worst file that holds rules, and read the survivors one by one, asking for each whether it is a missing test, an equivalent mutant, or a change we do not care about.


## Only what a pull request changed
A full run is too slow for every pull request on a large solution. `since` mutates only the files that changed compared to a commit, a branch or a tag:

```json
{
  "stryker-config": {
    "test-runner": "mtp",
    "since": { "enabled": true, "target": "main" }
  }
}
```

On a branch changing `QuietHours.cs` only, Stryker reported one changed file and tested 17 mutants instead of 37. A change to a test file makes it test the mutants those tests cover, and a change to a **non-C# file** of the test project makes it test everything. In our first try, the build output was not ignored by git, and the `bin/` and `obj/` files, along with `stryker-config.json` itself, counted as changes, so the filter selected all 37 mutants.

`--with-baseline` goes further: it stores a full report for the target branch (on disk, in the Stryker dashboard, in an Azure file share or an S3 bucket) and reuses its results for the mutants that did not change. It is marked experimental, and it cannot be combined with `since`: Stryker 5.0.0 refuses to start with both.


## What it costs
- **Time.** Each mutant runs the tests that cover it. Stryker captures coverage per test first, so a mutant only runs the tests that reach it, and it runs in parallel. On a model project with tests that take about a second, that is seconds. On a project whose tests start PostgreSQL with Testcontainers, like the [repository tests](/blog/2026-07-15-testing-ef-core-repositories-with-testcontainers/), every mutant pays for real database round trips, and a run can take hours.
- **Human time.** Every survivor needs a decision, and some of them, like the equivalent mutant above, are noise by construction.
- **A preview runner.** With Microsoft.Testing.Platform, the runner is marked as a preview. We checked a result by hand; we would do so again after an upgrade.
- **A number to game.** A score target invites tests written to kill mutants rather than to describe behaviour.


## When it is not worth it
Mutation testing pays off where code makes decisions: domain models, value objects, validators, pricing or permission rules. That is where a missing boundary case becomes a bug in production.

It is not worth it on code that only wires things: dependency injection registrations, EF Core configurations, controllers that pass a request to a port, adapters that wrap an SDK. The tests that matter for that code are the integration and [end-to-end tests](/blog/2026-09-25-end-to-end-tests-with-aspire-hosting-testing/), too slow to run once per mutant. Boundaries between projects are better held by [architecture tests](/blog/2026-07-03-architecture-tests-that-fail-the-build/).

For most teams, line coverage to find untested code, plus an occasional Stryker run on the few projects that hold the rules, is enough. A full mutation run on every build is rarely needed.


## Conclusion
Line coverage says which code ran; the mutation score says whether the tests would notice it changing. Stryker.NET makes the second measure a command away, and on the Starter's notification models it found, in sixteen seconds, a quiet-hours boundary that a fully covered method never tested. With the Microsoft.Testing.Platform runner set in `global.json`, it needs `--test-runner mtp`: the default runner reported a meaningless 0%.

Run it on the projects that hold the rules, read the survivors one by one, and treat the score as a pointer to missing cases rather than a target.

## References
- [Stryker.NET introduction (Stryker Mutator)](https://stryker-mutator.io/docs/stryker-net/introduction/) — installation and a first run.
- [Stryker.NET configuration (Stryker Mutator)](https://stryker-mutator.io/docs/stryker-net/configuration/) — every option of `stryker-config.json`, including `mutate`, `since`, `baseline`, `thresholds` and `test-runner`.
- [Stryker.NET mutations (Stryker Mutator)](https://stryker-mutator.io/docs/stryker-net/mutations/) — the list of mutators and their names for `ignore-mutations`.
- [Mutant states and metrics (Stryker Mutator)](https://stryker-mutator.io/docs/mutation-testing-elements/mutant-states-and-metrics/) — the states and how the mutation score is computed.
- [stryker-net (GitHub)](https://github.com/stryker-mutator/stryker-net) — the source and the issue tracker.
- [dotnet-stryker (NuGet)](https://www.nuget.org/packages/dotnet-stryker) — the tool package.
- [Microsoft.Testing.Platform overview (Microsoft Learn)](https://learn.microsoft.com/dotnet/core/testing/microsoft-testing-platform-intro) — the test platform selected in `global.json`.
- [Testing with dotnet test (Microsoft Learn)](https://learn.microsoft.com/dotnet/core/testing/unit-testing-with-dotnet-test) — how `global.json` chooses between VSTest and Microsoft.Testing.Platform.
- [Install and use a .NET local tool (Microsoft Learn)](https://learn.microsoft.com/dotnet/core/tools/local-tools-how-to-use) — the tool manifest.
