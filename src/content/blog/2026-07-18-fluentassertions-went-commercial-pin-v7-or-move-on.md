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

For years, FluentAssertions was the assertion library a .NET test project added without thinking. In January 2025, version 8 changed that. It is now published by Xceed under a licence that is free for open-source and non-commercial use, and paid for commercial use. Version 7 stays under Apache 2.0. A team on a commercial product has a decision to make, and Dependabot proposing `8.x` makes it urgent.

The cost of leaving is not in `.Should().Be(…)`. It is in the features we used without noticing, `BeEquivalentTo` first.


## Three ways out
- **Pin v7.** The Apache 2.0 line still works and receives critical fixes. Nothing changes in the code, and nothing new ever arrives.
- **Move to AwesomeAssertions**, a community fork that continues the Apache line with the same API. The package and the namespace change; the assertions do not.
- **Migrate** to [Shouldly](https://docs.shouldly.org/) or plain xUnit `Assert`. This is the only option that touches every test.

Pinning is one line with central package management, plus an ignore rule for `8.x` in the update bot:

```xml
<PackageVersion Include="FluentAssertions" Version="[7.2.2]" />
```

The brackets make it an exact version for NuGet, where a plain `7.2.2` means "7.2.2 or higher".


## Count before deciding
[Blouppy Starter](https://starter.blouppy.com/) pins FluentAssertions at 7.2.2. Its conventions say object comparison is always `.BeEquivalentTo()` against a **typed** expected object. An anonymous one only checks the members we thought of on the day, so a property added later goes unchecked.

Counting is the fastest way to see what a migration is about. Across its back end, the Starter has close to 800 `BeEquivalentTo` calls, about 90 with `WithStrictOrdering`, and over a hundred `ThrowAsync<T>`. `Should().Be(…)` translates one-to-one into any library. Those do not.


## What we lose: BeEquivalentTo and its options
`BeEquivalentTo` walks both object graphs and compares them member by member. The two objects need not share a type. Collections ignore order by default. The failure names the path of the member that differs, such as `Expected events[1].Text to be …`. The options on top are what is hard to replace.

**Global options.** The Starter's aggregates carry domain events with fresh timestamps, so an expected entity built in a test never matches. Each test project removes them once, when the assembly loads:

```csharp
public class UnitTestsFixture
{
    [ModuleInitializer]
    internal static void ExcludeDomainEvents()
    {
        AssertionOptions.AssertEquivalencyUsing(options => options
            .Excluding(x => x.Path == nameof(HasDomainEventsBase.DomainEvents)));
    }
}
```

This is also where v8 would break the code regardless of the licence. `AssertionOptions` became `AssertionConfiguration.Current`, and the call is now `AssertionConfiguration.Current.Equivalency.Modify(…)`.

**Strict ordering and runtime types.** The assistant streams a turn as a list of polymorphic records, and the test checks the exact sequence:

```csharp
events
    .Should()
    .BeEquivalentTo(new AssistantTurnEvent[]
    {
        new AssistantTextDelta("Nothing is "),
        new AssistantTextDelta("blocking it."),
        new AssistantTurnEnded(AssistantStopReason.Completed)
    }, options => options.WithStrictOrdering().RespectingRuntimeTypes());
```

Without `RespectingRuntimeTypes()`, the comparison follows the declared type, `AssistantTurnEvent`, which has no members of its own. Nothing of the concrete records would be compared.

**Per-type comparers.** PostgreSQL stores microseconds, so a repository test compares dates with `Using<DateTimeOffset>(… BeCloseTo(…)).WhenTypeIs<DateTimeOffset>()`.

The alternatives cover part of this. xUnit has `Assert.Equivalent`, and v3 adds `Assert.EquivalentWithExclusions`. But `Assert.Equivalent` ignores order, so it cannot replace `WithStrictOrdering`, and it has no global configuration and no per-type comparer. Shouldly 4.3 has `ShouldBeEquivalentTo` without options; its 5.0 previews add order and member exclusions, but no custom comparer.

Records help sometimes. The assistant test above only holds strings, booleans and enums, so `Assert.Equal(expected, events)` compares the sequence in order by value. That stops working as soon as a record holds a list, because a record's `Equals` compares the list by reference.

Without a global exclusion, every test comparing an aggregate must exclude `DomainEvents` by hand. The usual answer is a small helper per test project. It also has to be maintained and taught, which is what the library was doing for us.


## Scopes, exceptions and messages
`AssertionScope` collects every failure inside it and reports them together. The Starter's [architecture tests](/blog/2026-07-03-architecture-tests-that-fail-the-build/) loop over every domain, so three broken boundaries give three failures, not the first one. xUnit v3 has `Assert.Multiple(params Action[])` and Shouldly has `ShouldSatisfyAllConditions`. Both take a fixed list of actions, so a loop becomes a `Select` into lambdas.

`ThrowAsync<T>()` passes for `T` or a derived type, and chains `.WithMessage("*Business*")` with wildcards. xUnit's `Assert.ThrowsAsync<T>` requires the **exact** type; `Assert.ThrowsAnyAsync<T>` accepts derived ones. A mechanical translation silently changes what a hundred tests check.

The loss across the board is the failure message. FluentAssertions says which member of which element differed and what it expected. `Assert.True(events.SequenceEqual(expected))` says that `False` was not `True`, and the next developer reaches for a debugger.


## When pinning v7 is enough
For many teams, pinning is the right call. v7 targets .NET 6 and .NET Standard, and runs on .NET 10 with xUnit v3, as the Starter shows. An assertion library only runs in tests and never sees production traffic, so missing new features costs little. The suite keeps every option above, and nobody spends a sprint rewriting 800 checks.

The cost is slow: a line without new features, and one day a .NET or test framework change exposes a bug nobody fixes. AwesomeAssertions pushes that day back for the price of a namespace change in the global usings.

A migration to Shouldly or plain xUnit is worth it when a suite uses little of the above: mostly `Should().Be`, a few exceptions, `BeEquivalentTo` on small records. A suite built on structural comparison, global options and scopes would mostly be rewriting the library in its own helpers.


## References
- [Upgrading to version 8](https://fluentassertions.com/upgradingtov8) — Fluent Assertions: the breaking changes of v8, including `AssertionConfiguration`.
- [AwesomeAssertions](https://github.com/AwesomeAssertions/AwesomeAssertions) — the Apache 2.0 community fork.
- [Shouldly documentation](https://docs.shouldly.org/) — `ShouldBeEquivalentTo` and a guide for migrating from FluentAssertions.
- [xUnit.net v3 Assert API](https://api.xunit.net/v3/2.0.3/Xunit.Assert.html) — `Assert.EquivalentWithExclusions`, `Assert.Multiple` and `Assert.ThrowsAsync`.
