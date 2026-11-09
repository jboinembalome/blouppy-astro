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

A method can be fully covered by green tests and still hide a bug the tests would never notice. Line coverage says that a line **ran** during the tests, not that any test would fail if that line were wrong. A test with no assertion covers as many lines as a test with ten.

Mutation testing answers the second question. It changes the production code in small ways, runs the tests against each change, and counts the changes that no test noticed.


## Mutants
A **mutant** is a copy of the code with one small change: `>=` becomes `>`, `&&` becomes `||`, a statement is removed, a string becomes `""`. Take `IsAdult(int age) => age >= 18`, tested with 30 and 10. Coverage is 100%. Now replace `>=` with `>`: 30 is still an adult and 10 still a child, so the tests stay green. The mutant **survived**, and it points at the missing case: 18.

A mutant is **killed** when at least one test fails, and a **timeout** counts as killed too. It has **no coverage** when no test even runs the mutated code. One that does not compile is dropped. The **mutation score** is the share of valid mutants the tests detected:

```text
score = (killed + timeout) / (killed + timeout + survived + no coverage)
```

Line coverage tells us which code no test reaches. The mutation score tells us, for the code the tests reach, whether they would notice a change. A high coverage with a low score is the signature of tests that run code without checking what it does.


## Running Stryker.NET
Stryker.NET is a .NET tool, installed as a local tool so every developer and the CI run the same version (`dotnet tool install dotnet-stryker`). It mutates **one project** and runs the test projects that reference it. Its options can live in a `stryker-config.json`:

```json
{
  "stryker-config": {
    "project": "Blouppy.Notifications.Models.csproj",
    "test-runner": "mtp",
    "reporters": ["Html", "ClearText"],
    "mutate": ["**/Preferences/*.cs"],
    "thresholds": { "high": 80, "low": 60, "break": 50 }
  }
}
```

`mutate` narrows the run to the code that has rules worth testing. Below the `break` threshold, the command returns a non-zero exit code, which fails a CI job.

The line that matters is `test-runner`. [Blouppy Starter](https://starter.blouppy.com/) sets the runner of `dotnet test` to Microsoft.Testing.Platform in its `global.json`. Stryker.NET 5.0.0, the version we used, defaults to VSTest, and on the Starter's xUnit v3 tests that default failed quietly. Stryker logged that the coverage capture had failed, ran on, and reported all 39 tested mutants as survived: a score of 0%. With `"test-runner": "mtp"`, the run worked, with a warning that this runner is a preview. So we checked one result by hand, below. A score of 0% is the sign to look at the runner before looking at the tests.


## A real run
We ran Stryker on `Blouppy.Notifications.Models`: the notification, the reader's preferences per type and channel, and their quiet hours. The project has 28 tests. The whole run, build included, took about 16 seconds on a 4-core machine.

| Status | Mutants |
| --- | --- |
| Created | 50 |
| Compile error | 5 |
| Ignored | 6 |
| No coverage | 2 |
| Killed | 27 |
| Survived | 10 |

The score is 27 / (27 + 10 + 2), so **69.23%**. The ignored mutants are Stryker's own optimisation: it skips removing a block whose statements already carry mutants.

The file to read first was `QuietHours.cs`, at 82.35%. Its one rule decides whether a time falls inside the window:

```csharp
public bool Covers(TimeOnly localTime)
    => Start < End
        ? localTime >= Start && localTime < End
        // Wrapped: everything from the start to midnight, and from midnight to the end.
        : localTime >= Start || localTime < End;
```

The tests reach both branches, a window from 12:00 to 14:00 and one from 22:00 to 07:00. Every line runs. Yet `localTime >= Start` survived as `localTime > Start` on the first branch. The theory for the plain window checks 09:00, 12:30, 13:59 and 14:00, but never 12:00, the exact start. The wrapped window does check 22:00, which is why the same mutant on the other branch was killed. We applied the mutant by hand and ran `dotnet test`: all 28 tests passed, so the report was right. Adding `[InlineData(12, 0, true)]` kills it, and the file goes to 88.24%.

The two mutants still alive there show the limits of the score. One empties the exception's message, and the test only checks the exception type; pinning a message is a choice, not a missing test. The other turns `Start < End` into `Start <= End`. The constructor refuses a window that starts when it ends, so both versions behave the same. That is an **equivalent mutant**: no test can kill it, and only a person can recognise one.

So the HTML report, which shows every mutant on its line, is read survivor by survivor: a missing test, an equivalent mutant, or a change we do not care about?


## Only what changed
A full run is too slow for every pull request on a large solution. The `since` option mutates only the files that changed against a branch. On a branch changing `QuietHours.cs` only, Stryker tested 17 mutants instead of 37. One trap: a change to a non-C# file of the test project makes it test everything. In our first try, `bin/` and `obj/` were not ignored by git, so they counted as changes and the filter selected all 37.


## Where it pays
Mutation testing pays off where code makes decisions: domain models, value objects, validators, pricing or permission rules. That is where a missing boundary becomes a bug in production. On a model project whose tests take a second, a run takes seconds.

It is not worth it on code that only wires things: DI registrations, EF Core configurations, controllers that pass a request on. The tests that matter there are integration tests, and with a real PostgreSQL per run, every mutant pays for database round trips, so a run can take hours. Every survivor also costs a decision, and a score target invites tests written to kill mutants rather than to describe behaviour. Line coverage, plus an occasional Stryker run on the projects that hold the rules, is enough for most teams.


## References
- [Stryker.NET configuration](https://stryker-mutator.io/docs/stryker-net/configuration/) — Stryker Mutator: every option, including `mutate`, `since` and `test-runner`.
- [Mutant states and metrics](https://stryker-mutator.io/docs/mutation-testing-elements/mutant-states-and-metrics/) — Stryker Mutator: the states and how the score is computed.
- [Microsoft.Testing.Platform overview](https://learn.microsoft.com/dotnet/core/testing/microsoft-testing-platform-intro) — Microsoft Learn: the test platform selected in `global.json`.
