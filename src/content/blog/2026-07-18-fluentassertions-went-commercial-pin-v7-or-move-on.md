---
templateKey: 'blog-post'
title: 'FluentAssertions went commercial: pin v7, or move on?'
date: 2026-07-18T09:00:00.000Z
author: Jimmy Boinembalome
authorimage: /img/jimmy.jpg
category: C#
topic: 'Testing'
illustration: 1
categorycolor: bg-purple-100 text-purple-800
featuredpost: true
description: >-
  Learn what the FluentAssertions v8 licence change means for a .NET test suite, how to pin v7 safely, and which features BeEquivalentTo users lose when moving to Shouldly or plain xUnit.
tags:
  - Development
  - C#
  - Testing
  - xUnit
---

For years, FluentAssertions was the assertion library a .NET test project added without thinking, next to xUnit and Moq. In January 2025, version 8 changed that: it is now published by Xceed under a licence that is free for open-source and non-commercial use, and paid for commercial use. Version 7 stays under Apache 2.0. A team on a commercial product now has a decision to make, and Dependabot proposing `8.x` turns it into an urgent one.

In this article, we will look at the three ways out: pinning v7, moving to the AwesomeAssertions fork, or migrating to another library. Most of the article is about the third, because the cost of a migration is not in `.Should().Be(…)`: it is in the features we used without noticing, `BeEquivalentTo` first.


## Three options
- **Pin v7.** The Apache 2.0 line still works and the maintainers said it would receive critical fixes. Nothing changes in the code. It also means no new features, ever.
- **Move to AwesomeAssertions.** A community fork that continues the Apache-licensed line with the same API. The package and the namespace change (`using AwesomeAssertions;`), the assertions do not.
- **Migrate** to [Shouldly](https://docs.shouldly.org/), plain xUnit `Assert`, or NUnit's constraint model (`Assert.That(actual, Is.EqualTo(expected))`) if the project is on NUnit. This is the only option that touches every test.

Pinning is one line in `Directory.Packages.props`, and an ignore rule for `8.x` in the update bot's configuration so that it stops offering the upgrade. An exact version range makes the intent explicit:

```xml
<PackageVersion Include="FluentAssertions" Version="[7.2.2]" />
```

The brackets make it an exact version for NuGet, where a plain `7.2.2` means "7.2.2 or higher". With central package management, every test project inherits the pin.


## What a real suite uses
[Blouppy Starter](https://starter.blouppy.com/) pins `FluentAssertions` at `7.2.2` in `back/Directory.Packages.props`, beside xUnit v3, AutoFixture and Moq. Its 39 test projects each declare the same global usings:

```csharp
global using AutoFixture;
global using FluentAssertions;
global using Moq;
global using Xunit;
```

The project's conventions add a rule: object comparison is always `.BeEquivalentTo()`, against a **typed** expected object, never an anonymous one. An anonymous `new { x.Name, IsActive = true }` only checks the members we thought of on the day; a property added to the type later goes unchecked and the test stays green. With a typed expected object, the new property must be set, or the test fails.

Counting is the fastest way to see what a migration is really about. Across the back end:

| Feature | Uses |
| --- | --- |
| `BeEquivalentTo(` | 775 |
| `ContainSingle` | 179 |
| `ThrowAsync<` | 112 |
| `WithMessage` | 98 |
| `Excluding(` | 88 |
| `WithStrictOrdering` | 87 |
| `new AssertionScope()` | 10 |

`Should().Be(…)` and `Should().BeTrue()` translate one-to-one into any library. The rows above do not, so let us go through them.


## What we lose: BeEquivalentTo
`BeEquivalentTo` walks both object graphs and compares them member by member. The expected and actual objects do not need to be the same type, collections ignore order by default, and the failure message names the path of the member that differs (`Expected events[1].Text to be …`). On top of that comes a set of options.

**Global options.** Blouppy's aggregates inherit `HasDomainEventsBase`. An expected entity built in the Arrange step raises its own events, each with a fresh timestamp, so an equivalency check would never match. One global option, in a shared test helper, takes them out:

```csharp
namespace Blouppy.Shared.TestHelpers.FluentAssertions;

public static class EquivalencyDefaults
{
    public static void ExcludeDomainEvents()
        => AssertionOptions.AssertEquivalencyUsing(options => options
            .Excluding(x => x.Path == nameof(HasDomainEventsBase.DomainEvents)));
}
```

Each test project applies it once, from a `[ModuleInitializer]` in its `UnitTestsFixture.cs`, so it holds before the first test of the assembly runs (why a static constructor is not enough is explained in [testing EF Core repositories with Testcontainers](/blog/2026-07-15-testing-ef-core-repositories-with-testcontainers/)):

```csharp
public class UnitTestsFixture
{
    [ModuleInitializer]
    internal static void ExcludeDomainEvents()
    {
        EquivalencyDefaults.ExcludeDomainEvents();
    }
}
```

This is the one place where v8 would break the Starter's code without any licence question: in v8, `AssertionOptions` became `AssertionConfiguration.Current`, and the call is `AssertionConfiguration.Current.Equivalency.Modify(…)`.

**Strict ordering and runtime types.** The assistant streams a turn as a list of polymorphic records. The test checks the exact sequence, with the members of each concrete type:

```csharp
events
    .Should()
    .BeEquivalentTo(new AssistantTurnEvent[]
    {
        new AssistantTextDelta("Nothing is "),
        new AssistantTextDelta("blocking it."),
        new AssistantUsage(LimitReached: false),
        new AssistantTurnEnded(AssistantStopReason.Completed)
    }, options => options.WithStrictOrdering().RespectingRuntimeTypes());
```

Without `RespectingRuntimeTypes()`, the comparison is driven by the declared type, `AssistantTurnEvent`, which declares no members of its own, so the members of the concrete records would not be compared.

**Per-type comparers.** PostgreSQL stores microseconds and a round trip can move a date by less than a millisecond, so a repository test compares dates with a tolerance:

```csharp
result.Value!.Notifications
    .Should()
    .ContainSingle()
    .Which
    .Should()
    .BeEquivalentTo(expected, options => options
        .Using<DateTimeOffset>(context => context.Subject.Should().BeCloseTo(context.Expectation, TimeSpan.FromMilliseconds(1)))
        .WhenTypeIs<DateTimeOffset>());
```

FluentAssertions also handles cyclic references in a graph (an option decides whether to throw or ignore them), so a parent that references its children, which reference the parent, does not overflow the stack.

### What the alternatives offer
- **xUnit** has `Assert.Equivalent(expected, actual, strict)` since 2.4.2, and xUnit v3 adds `Assert.EquivalentWithExclusions`, which takes the members to leave out as strings or expressions. `Assert.Equivalent` compares collections **regardless of order**, so it cannot stand in for `WithStrictOrdering`. There is no global configuration and no per-type comparer.
- **Shouldly** 4.3, the current stable release, has `ShouldBeEquivalentTo` without options. The 5.0 previews add `EquivalencyOptions` with `IgnoreOrder` and `MembersToIgnore`, which matches members by name anywhere in the graph. The previews document no custom comparer and no approximate date matching.
- **Records.** For the assistant test above, plain `Assert.Equal(expected, events)` is enough: the records only hold strings, booleans and enums, so their generated `Equals` compares by value, and `Assert.Equal` on two sequences compares them in order. That stops working as soon as a record holds a list: a record's `Equals` compares the list by reference, which is why the same test file's `LlmMessage` comparisons, whose content is a list of parts, need the structural comparison.

### What we would write ourselves
Each global option becomes a convention. Without a global exclusion, every test that compares an aggregate must exclude `DomainEvents` by hand, and the day someone forgets, the test fails for a reason unrelated to what it checks. The usual way out is a small helper per test project:

```csharp
internal static class Equivalence
{
    public static void ShouldMatch<T>(T actual, T expected)
        where T : HasDomainEventsBase
        => Assert.EquivalentWithExclusions(expected, actual, nameof(HasDomainEventsBase.DomainEvents));
}
```

That covers exclusions. The ordered polymorphic comparison and the date tolerance have no equivalent, so those tests either compare members one by one, round the dates before comparing, or keep a structural comparison library just for them. A helper also has to be maintained, documented and taught, which is what the library was doing for us.


## What we lose: assertion scopes
`AssertionScope` collects every failure inside it and reports them together. The Starter's architecture tests rely on it: one test loops over every domain and checks its references, and a broken boundary in three domains reports three failures rather than the first one (see [architecture tests that fail the build](/blog/2026-07-03-architecture-tests-that-fail-the-build/)):

```csharp
[Fact]
public void A_domain_should_not_reference_another_domain_or_its_models()
{
    using var scope = new AssertionScope();

    foreach (var domain in Domains)
    {
        // Arrange, Act, Assert for this domain
    }
}
```

xUnit v3 has `Assert.Multiple(params Action[])`, which runs every action and reports all the failures. It takes a fixed list of actions, so a loop becomes a `Select` into an array of lambdas. Shouldly has `ShouldSatisfyAllConditions` (renamed `ShouldSatisfy` in the 5.0 previews), with the same shape.


## What we lose: exceptions and collections
`ThrowAsync<T>()` passes for `T` or a derived type, and chains `.WithMessage("*Business*")` with wildcards, or `.Where(e => …)` on any property of the exception:

```csharp
await act
    .Should()
    .ThrowAsync<InvalidOperationException>()
    .WithMessage($"*{PlanType.Business}*");
```

Both alternatives return the exception and let us assert on it ourselves. xUnit's `Assert.ThrowsAsync<T>` requires the **exact** type (`Assert.ThrowsAnyAsync<T>` accepts derived types), which silently changes what 112 tests check if we translate them mechanically. The wildcard message becomes `Assert.Contains("Business", exception.Message)`; in Shouldly, `Should.ThrowAsync<T>` returns the exception too, and the message check is `exception.Message.ShouldContain(…)`.

`ContainSingle().Which` maps well: xUnit's `Assert.Single` returns the element, and so does Shouldly's `ShouldHaveSingleItem`. `ContainEquivalentOf`, `BeInAscendingOrder` and the other collection assertions need a LINQ expression and a plain `Assert.True`, whose failure message says only that `False` was not `True`.

That last point is the real loss across the board. A FluentAssertions failure tells us which member of which element differed, and what it expected. `Assert.True(events.SequenceEqual(expected))` tells us nothing, and the next developer reaches for a debugger to find out.


## When pinning v7 is enough
Pinning is the cheapest option and, for many teams, the right one:

- v7 ships for .NET 6 and .NET Standard 2.0 and 2.1, and runs on .NET 10 with xUnit v3, as the Starter shows.
- An assertion library runs in tests only. It reads our objects and throws exceptions; it never sees production traffic, so missing new features costs little.
- The suite keeps every option above, and nobody spends a sprint rewriting 775 equivalency checks.

The cost is slow: a line that will not get new features, and a day when a new .NET version or test framework exposes a bug nobody fixes. Moving to AwesomeAssertions pushes that day back at the price of a namespace change, which a search and replace across the global usings handles. Like any library, its new major versions have their own breaking changes, so we read the release notes before following them.

A migration to Shouldly or plain xUnit is worth it when a suite uses little of the above: mostly `Should().Be`, a few exceptions, `BeEquivalentTo` on small records. A suite built on structural comparison, global options and assertion scopes, like the Starter's, would mostly be rewriting the library in its own helpers.


## Conclusion
The licence change does not force a migration: v7 keeps working under Apache 2.0, and AwesomeAssertions continues it with the same API. What a migration costs depends on which features the suite leans on, and the answer for most suites is `BeEquivalentTo` with its options, assertion scopes and exception chains. Counting them first, as we did here, turns a debate about licences into an estimate.

This is the state of the test suite in [Blouppy Starter](https://starter.blouppy.com/): FluentAssertions pinned at 7.2.2, with the conventions above.

## References
- [Fluent Assertions](https://fluentassertions.com/) — the library's documentation, including the object graph comparison options.
- [Upgrading to version 8 (Fluent Assertions)](https://fluentassertions.com/upgradingtov8) — the breaking changes of v8, including `AssertionConfiguration`.
- [FluentAssertions 8 licence (NuGet)](https://www.nuget.org/packages/FluentAssertions/) — the package page and its licence terms.
- [AwesomeAssertions (GitHub)](https://github.com/AwesomeAssertions/AwesomeAssertions) — the Apache 2.0 community fork.
- [Shouldly documentation](https://docs.shouldly.org/) — `ShouldBeEquivalentTo`, `ShouldSatisfyAllConditions` and a guide for migrating from FluentAssertions.
- [xUnit.net 2.4.2 release notes](https://xunit.net/releases/v2/2.4.2) — the introduction of `Assert.Equivalent`.
- [xUnit.net v3 Assert API](https://api.xunit.net/v3/2.0.3/Xunit.Assert.html) — `Assert.EquivalentWithExclusions`, `Assert.Multiple` and `Assert.ThrowsAsync`.
- [NuGet version ranges (Microsoft Learn)](https://learn.microsoft.com/nuget/concepts/package-versioning#version-ranges) — the `[7.2.2]` exact-version syntax.
- [ModuleInitializerAttribute (Microsoft Learn)](https://learn.microsoft.com/dotnet/api/system.runtime.compilerservices.moduleinitializerattribute) — code that runs when the assembly loads.
