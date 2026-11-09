---
templateKey: 'blog-post'
title: 'Compare against a typed expected object in C# tests'
date: 2027-02-25T09:00:00.000Z
author: Jimmy Boinembalome
authorimage: /img/jimmy.jpg
category: C#
topic: 'Testing'
illustration: 3
categorycolor: bg-purple-100 text-purple-800
featuredpost: true
description: >-
  Learn why an equivalency assertion in C# should compare against a typed expected object rather than an anonymous one, with FluentAssertions, justified exclusions and expected-object helpers.
tags:
  - Development
  - C#
  - Testing
  - xUnit
---

An equivalency assertion compares an object with an expectation, member by member. It reads well and gives a good failure message. It also has one quiet trap: the expectation decides which members are compared.

Write the expectation as an anonymous object, `new { x.Name, IsActive = true }`, and the test checks exactly those two members, forever. A property added to the type next month is never checked, and the test stays green whatever the code puts in it.


## The expectation drives the comparison
By default, FluentAssertions' `subject.Should().BeEquivalentTo(expectation)` walks the members of the **expectation**, not those of the subject. For each one, it looks up the member of the same name on the subject and compares the values, recursively. A member that only the subject has is ignored.

Take a `Customer` with a `Name`, an `Email` and an `IsActive` flag that the constructor sets to `true`. Here is the same test written both ways:

```csharp
// Anonymous: compares Name, Email and IsActive, and nothing else, ever.
customer
    .Should()
    .BeEquivalentTo(new { Name = "Ada", Email = "ada@example.com", IsActive = true });

// Typed: compares every member Customer has, today and tomorrow.
var expected = new Customer("Ada", "ada@example.com");

customer
    .Should()
    .BeEquivalentTo(expected);
```

Both pass. The difference only shows when the type changes.


## A new member, two outcomes
Some weeks later, `Customer` gains a `Locale`, set by the constructor from a new parameter. A bug slips in: the service passes the browser's locale where it should pass the organization's default.

The anonymous expectation still has three members. FluentAssertions compares those three, finds them equal, and the test passes. Nothing in the suite says that `Locale` exists, so nothing says it is wrong. The anonymous object only catches a rename, when the expectation has a member the subject lacks. Additions, which are far more common, go through.

With the typed expectation, the build breaks first: `new Customer("Ada", "ada@example.com")` no longer compiles. The test author has to pass a locale, so they have to decide what the expected locale is. If the code disagrees, the failure names the member:

```text
Expected property customer.Locale to be "fr-FR", but "en-US" differs near "en-".
```

That failure is the point. Every new member becomes a decision for the test: check it, or exclude it with a reason.

It is not a full guarantee. A property set from a default inside the type, with no constructor parameter, gets the same default on both sides, and nobody decides anything. But it is still compared, so the day the code sets it differently, the test fails.


## Exclude only what legitimately differs
Some members cannot match. [Blouppy Starter](https://starter.blouppy.com/) writes the rule in its contributor instructions: compare against a typed expected object, and exclude only what legitimately differs. Its webhook test is the example. Creating a webhook generates a random signing secret, so the test builds the expected `Webhook` through the same constructor and leaves out that one member (trimmed):

```csharp
var expected = new Webhook(creation.OrganizationId, creation.Url, creation.Events, creation.Headers)
{
    Id = new WebhookId(4)
};

var result = await _sut.TryAddAsync(creation, TestContext.Current.CancellationToken);

result.Value
    .Should()
    .BeEquivalentTo(expected, options => options.Excluding(x => x.Secret));

result.Value.Secret
    .Should()
    .NotBeNullOrWhiteSpace();
```

The exclusion is an expression, so renaming the property renames it and deleting the property breaks the build. And the excluded member is not forgotten: the next assertion checks what can be checked about a random secret, that it is there.

The good reasons are few: randomness (a secret, a token hash), the clock (an event's `OccurredAt`, a measured duration) and identifiers the code generates. "Not what this test is about" is not one of them. A test that excludes half the members has gone back to an anonymous expectation, with more typing.

One exclusion is needed everywhere. The Starter's aggregates raise domain events in their constructors, so an expected entity built in the Arrange step carries its own events, with their own timestamps. Each test project excludes `DomainEvents` once, from a `[ModuleInitializer]` that runs when the assembly loads. Tests that care about the events assert on them directly, as the webhook test does.


## Keeping the expectation cheap
A typed expected object costs more to write, especially when the constructor takes ten arguments. The answer is a helper in the test class, named for what it returns. The Starter's AI gateway tests build each expected usage record with `Expected_record(outcome, model, usage, credits)`, which calls the real constructor and fills the rest with the test's constants. Its exclusions also have a name, `Excluding_what_the_clock_decides`. A new constructor parameter then breaks the helper once, not thirty tests, and the person who fixes it decides the expected value in one place.

The same comparison works inside a Moq verification. A small `CustomIt.IsEquivalentTo(expected, options)` wraps `BeEquivalentTo` in `Match.Create`, so the object passed to a repository or a publisher is checked against a typed expectation too. A mismatch then fails with FluentAssertions' message instead of Moq's generic "expected invocation not performed".

xUnit's own `Assert.Equivalent(expected, actual)` has the same trap: with the default `strict: false`, extra members on the actual object are ignored. The same rule applies there.


## When it is not worth it
A test about one rule, "the e-mail is stored in lower case", is clearer as one targeted assertion: `customer.Email.Should().Be("ada@example.com")`. The typed expected object is for tests that claim to check the whole result of an operation: the created entity, the published event, the written record. There, a missing member is a missing check.

The cost is real. A new property on a widely used type fails every test that compares it, and the easy fix for a red test is one more `.Excluding`. Review has to treat each exclusion as a claim that needs a reason.


## References
- [Object graph comparison](https://fluentassertions.com/objectgraphs/) — FluentAssertions: `BeEquivalentTo`, `Excluding` and the global options.
- [ModuleInitializerAttribute](https://learn.microsoft.com/dotnet/api/system.runtime.compilerservices.moduleinitializerattribute) — Microsoft Learn: code that runs when an assembly loads.
- [Testing EF Core repositories with Testcontainers](/blog/2026-07-15-testing-ef-core-repositories-with-testcontainers/) — why the exclusion of domain events is not in a static constructor.
