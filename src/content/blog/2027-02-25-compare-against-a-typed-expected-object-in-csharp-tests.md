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

An equivalency assertion compares an object with an expectation member by member. It reads well, it gives a good failure message, and it has one quiet trap: the expectation decides which members are compared. Write the expectation as an anonymous object, `new { x.Name, IsActive = true }`, and the test checks exactly those two members, today and forever. A property added to the type next month is never checked, and the test stays green whatever the code puts in it.

In this article, we will look at both failure modes with FluentAssertions' `BeEquivalentTo`, the version the [Blouppy Starter](https://starter.blouppy.com/) pins (7.x), then at the exclusions that are justified, the global exclusion of domain events, and the small helpers that keep a typed expected object cheap to write. We will finish with xUnit's own `Assert.Equivalent` and with the cases where none of this is worth the trouble.


## The expectation drives the comparison
By default, `subject.Should().BeEquivalentTo(expectation)` walks the members of the **expectation**, not those of the subject. For each one, it looks up the member of the same name on the subject and compares the values, recursively. A member that only the subject has is ignored.

Take a small entity and a service that creates it:

```csharp
public sealed class Customer
{
    public Customer(string name, string email)
    {
        Name = name;
        Email = email;
        IsActive = true;
    }

    public string Name { get; }

    public string Email { get; }

    public bool IsActive { get; }
}
```

Here is the test written with an anonymous expectation:

```csharp
[Fact]
public void Should_create_an_active_customer_when_the_input_is_valid()
{
    // Act
    var customer = _sut.Create("Ada", "ada@example.com");

    // Assert
    customer
        .Should()
        .BeEquivalentTo(new { Name = "Ada", Email = "ada@example.com", IsActive = true });
}
```

And here with a typed one:

```csharp
[Fact]
public void Should_create_an_active_customer_when_the_input_is_valid()
{
    // Arrange
    var expected = new Customer("Ada", "ada@example.com");

    // Act
    var customer = _sut.Create("Ada", "ada@example.com");

    // Assert
    customer
        .Should()
        .BeEquivalentTo(expected);
}
```

Both pass. The difference only shows when the type changes.


## Failure mode 1: the anonymous object stays green
Some weeks later, `Customer` gains a `Locale`, set by the constructor from a new parameter, and the service is changed to pass it. A bug slips in: the service passes the browser's locale where it should pass the organization's default.

The anonymous expectation has three members: `Name`, `Email`, `IsActive`. FluentAssertions compares those three, finds them equal, and the test passes. Nothing in the suite says that `Locale` exists, so nothing says it is wrong. The reviewer sees a green build and a test whose name still claims to check the created customer.

The anonymous object does catch one kind of change: if `Email` is renamed to `EmailAddress`, the expectation has a member the subject lacks, and the assertion fails. Renames are caught. Additions, which are far more common, are not.


## Failure mode 2: the typed object fails until the test decides
With the typed expectation, the new constructor parameter breaks the build first: `new Customer("Ada", "ada@example.com")` no longer compiles. The test author has to pass a locale, so they have to decide what the expected locale is. If they pass the organization's default and the service passes the browser's, FluentAssertions fails with a message that names the member, along these lines:

```text
Expected property customer.Locale to be "fr-FR", but "en-US" differs near "en-".
```

This failure is the point. A typed expected object makes every new member a decision for the test: check it, or exclude it with a reason. The silent case is gone.

It is not a guarantee, though. A property set from a default inside the type, with no constructor parameter, gets the same default on both sides, and the test passes without anyone deciding. The typed expectation still compares that property, so the day the code under test sets it differently, the test fails. That is already much better than never looking.


## The rule in the Starter
The Starter writes this down in the testing section of its contributor instructions: always compare with `.BeEquivalentTo()` against a **typed** expected object, never an anonymous one, because a property added to the type later would go unchecked and the test would stay green; and exclude only what legitimately differs, as in `options => options.Excluding(x => x.Secret)`.

The example in that last sentence comes from a real test. `WebhooksService.TryAddAsync` creates a webhook and generates its signing secret. The test builds the expected `Webhook` through the same public constructor and leaves out only the secret:

```csharp
[Fact]
public async Task Should_add_the_webhook_with_a_secret_when_the_creation_is_valid()
{
    // Arrange
    var creation = new WebhookCreation
    {
        OrganizationId = OrganizationId,
        Url = "https://example.com/hooks",
        Events = [WebhookEventType.WorkspaceCreated, WebhookEventType.OrganizationInvitationCreated],
        Headers = new Dictionary<string, string> { ["X-Api-Key"] = "k" }
    };

    _creationValidator.SetupValidationSucceed();
    Given_the_repository_gives_the_new_webhook_its_id();

    var expected = new Webhook(creation.OrganizationId, creation.Url, creation.Events, creation.Headers)
    {
        Id = new WebhookId(4)
    };

    // Act
    var result = await _sut.TryAddAsync(creation, TestContext.Current.CancellationToken);

    // Assert
    result.Value
        .Should()
        .BeEquivalentTo(expected, options => options.Excluding(x => x.Secret));

    result.Value.Secret
        .Should()
        .NotBeNullOrWhiteSpace();
}
```

Two details matter. The exclusion is an expression, `x => x.Secret`, so renaming the property renames the exclusion, and deleting it breaks the build. And the excluded member is not forgotten: the next assertion checks what can be checked about a random secret, that it is there.


## Exclusions that are justified
An exclusion is a statement that a member legitimately differs between the expected object and the actual one. In the Starter's tests, the reasons fall into a few groups.

**Randomness.** A secret, a token, a token hash. `OrganizationInvitationsServiceTests` verifies the invitation handed to the repository and excludes `Id`, `TokenHash`, `ExpiresAt` and `DomainEvents`, with a comment on the token: its value is not predictable, so the test creates a new one only to satisfy the constructor.

**The clock.** A domain event's `DateOccurred`, an integration event's `OccurredAt`, a measured `Duration`. The workspace model tests compare a raised `WorkspaceCreatedDomainEvent` with `.Excluding(x => x.DateOccurred)`, and nothing else.

**Identifiers the code generates.** An `Id` created by `AiUsageRecordId.Create()` inside the constructor cannot match a second instance.

What is not a reason: a member that is "not what this test is about". If the test does not care about `Locale`, the expected object still states the value the code is supposed to produce. A test that excludes half of the members has quietly gone back to an anonymous expectation, with more typing.


## Domain events, excluded once
Aggregates in the Starter inherit `HasDomainEventsBase` and raise events in their constructors. An expected entity built in the Arrange step raises its own events, each with its own `DateOccurred`, so a plain `BeEquivalentTo(expected)` on an aggregate would never pass. Writing `.Excluding(x => x.DomainEvents)` in every test would bury the exclusions that matter.

The Starter excludes them once per test assembly, through a shared helper:

```csharp
public static class EquivalencyDefaults
{
    public static void ExcludeDomainEvents()
        => AssertionOptions.AssertEquivalencyUsing(options => options
            .Excluding(x => x.Path == nameof(HasDomainEventsBase.DomainEvents)));
}
```

Each test project calls it from a `[ModuleInitializer]` in its `UnitTestsFixture.cs`, so it runs when the assembly loads, before any test:

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

The [Testcontainers article](/blog/2026-07-15-testing-ef-core-repositories-with-testcontainers/) explains why a static constructor is the wrong place for it. The events are not left unchecked: tests that care about them assert on `DomainEvents` directly, like the webhook test above with `ContainSingle(x => x is WebhookCreatedDomainEvent, ...)`.

`AssertionOptions.AssertEquivalencyUsing` is the global configuration API of FluentAssertions 7. Version 8 changed the global configuration API and moved the library to a commercial license, which is one reason a project may stay on 7.


## Helpers that build the expected object
A typed expected object costs more to write than an anonymous one, especially when the constructor takes ten arguments. The answer is a helper in the test class, named for what it returns. `AiGatewayTests` checks the usage record the gateway writes on every call, and builds the expectation with `Expected_record`:

```csharp
private static AiUsageRecord Expected_record(
    AiUsageOutcome outcome,
    string model,
    LlmUsage usage,
    int credits,
    AiFeature feature = AiFeature.WorkspaceDescriptionDraft,
    AiKeySource keySource = AiKeySource.Platform)
    => new(
        OrganizationId,
        UserId,
        feature,
        keySource,
        FakeLlmClient.ProviderName,
        model,
        new AiTokenCounts(usage.InputTokens, usage.OutputTokens, usage.CacheReadTokens, usage.CacheWriteTokens),
        credits,
        outcome,
        turnId: null,
        TimeSpan.Zero);

private static EquivalencyAssertionOptions<AiUsageRecord> Excluding_what_the_clock_decides(
    EquivalencyAssertionOptions<AiUsageRecord> options)
    => options
        .Excluding(x => x.Id)
        .Excluding(x => x.Duration)
        .Excluding(x => x.OccurredAt);
```

A test then reads as one sentence:

```csharp
_recorded
    .Should()
    .ContainSingle()
    .Which
    .Should()
    .BeEquivalentTo(
        Expected_record(AiUsageOutcome.Completed, FakeLlmClient.ModelName, Usage, credits: UsageInCredits),
        Excluding_what_the_clock_decides);
```

The helper goes through the real constructor, so a new parameter on `AiUsageRecord` breaks the helper once, not thirty tests, and the person who fixes it decides the expected value in one place. The exclusions have a name that states their reason.

The same comparison works inside a Moq verification. The Starter's `CustomIt.IsEquivalentTo` wraps `BeEquivalentTo` in `Match.Create`, so a test can verify the object passed to a repository or a publisher against a typed expectation, with the same exclusions:

```csharp
Mock.Get(_integrationEventPublisher)
    .Verify(x => x.PublishAsync(
        CustomIt.IsEquivalentTo(expectedIntegrationEvent, options => options
            .Excluding(@event => @event.Token)
            .Excluding(@event => @event.OccurredAt)),
        It.IsAny<CancellationToken>()), Times.Once);
```

Because the helper asserts rather than returning `false`, a mismatch fails with FluentAssertions' message naming the member instead of Moq's generic "expected invocation not performed".


## The same idea with xUnit's Assert.Equivalent
xUnit has its own structural comparison, `Assert.Equivalent(expected, actual, strict)`. With the default `strict: false`, the actual object may carry members the expected one does not have, which is exactly the anonymous-object trap. The same rule applies: build the expected value with the real type, and pass `strict: true` when the expected object is not of the actual type, so that extra members on the actual object fail the assertion. FluentAssertions remains more convenient when some members must be excluded, since its options take expressions.


## What it costs, and when not to bother
- **More code in the Arrange step.** Building a real entity means satisfying its constructor and its invariants. Helpers bring this down, but it never reaches the brevity of `new { x.Name }`.
- **Tests break on unrelated changes.** A new property on a widely used type fails every test that compares it. That is the intended behaviour, yet it is real work, and it is the most common complaint.
- **Over-exclusion.** Under pressure, the easy fix for a red test is one more `.Excluding`. Code review has to treat an exclusion as a claim that needs a reason.

It depends on what is asserted. A test about one rule, "the e-mail is stored in lower case", is clearer as one targeted assertion on that member: `customer.Email.Should().Be("ada@example.com")`. The typed expected object is for tests that claim to check the whole result of an operation, the created entity, the published event, the written record, where a missing member is a missing check. For a primitive or a collection of primitives, `Be` or `Equal` is enough.


## Conclusion
An anonymous expectation freezes the list of compared members on the day the test is written. A typed expected object compares whatever the type has, so a new member either breaks the build or fails the assertion until the test states what it expects. Exclusions stay few, written as expressions and justified by randomness, the clock or generated identifiers, and domain events are excluded once from a `[ModuleInitializer]`. Helpers like `Expected_record` keep the expectation cheap.

The same "decide for every member" idea is behind the coverage tables in the [architecture tests article](/blog/2026-07-03-architecture-tests-that-fail-the-build/). These conventions are the ones used in the tests of [Blouppy Starter](https://starter.blouppy.com/).

## References
- [Object graph comparison (FluentAssertions)](https://fluentassertions.com/objectgraphs/) — `BeEquivalentTo`, the expectation-driven comparison, `Excluding` and the global options.
- [FluentAssertions on NuGet](https://www.nuget.org/packages/FluentAssertions) — the package and its versions.
- [ModuleInitializerAttribute (Microsoft Learn)](https://learn.microsoft.com/dotnet/api/system.runtime.compilerservices.moduleinitializerattribute) — code that runs when an assembly loads.
- [Anonymous types (Microsoft Learn)](https://learn.microsoft.com/dotnet/csharp/fundamentals/types/anonymous-types) — what an anonymous object is in C#.
- [xUnit.net v3 documentation](https://xunit.net/docs/getting-started/v3/getting-started) — the test framework, including `Assert.Equivalent`.
- [Moq on GitHub](https://github.com/devlooped/moq) — `Match.Create` and argument matching in `Verify`.
