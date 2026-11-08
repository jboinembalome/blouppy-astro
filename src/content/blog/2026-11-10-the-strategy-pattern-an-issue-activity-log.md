---
templateKey: 'blog-post'
title: 'The Strategy pattern in C#: one class per field in an issue activity log'
date: 2026-11-10T09:00:00.000Z
author: Jimmy Boinembalome
authorimage: /img/jimmy.jpg
category: C#
topic: 'Architecture'
illustration: 1
categorycolor: bg-purple-100 text-purple-800
featuredpost: true
description: >-
  Learn the Strategy pattern in C# through a real issue activity log, where generics pick one class per field, and when a switch expression is enough.
tags:
  - Development
  - C#
  - Design Patterns
  - DDD
---

An issue tracker keeps a history: "Alice changed the priority from Low to High", "Bob removed the label Bug". The first version of that code is usually one method with a `switch` on the field. Then each field grows its own rules. The assignee is stored as an id but shown as a name, labels come as a list where several can be added and removed in one save, and a milestone may have been deleted since. The method becomes the longest in the code base, and every new field means editing it again.

In this article, we will look at the Strategy pattern: its shape in a few lines, then the activity log of a project-management app built on [Blouppy Starter](https://starter.blouppy.com/), where each tracked field has its own strategy class and a generic interface picks the right one. We will finish with a strategy chosen by configuration in the Starter itself, when a `switch` is enough, and what the pattern costs.


## The pattern in a few lines
The Strategy pattern is one of the Gang of Four's **behavioral** patterns. It puts each variant of an algorithm in its own class, behind one interface, so the code that uses it does not know which variant it holds.

```csharp
public interface IShippingCostStrategy
{
    decimal Compute(Parcel parcel);
}

internal sealed class FlatRateShipping : IShippingCostStrategy
{
    public decimal Compute(Parcel parcel) => 5m;
}

internal sealed class WeightBasedShipping : IShippingCostStrategy
{
    public decimal Compute(Parcel parcel) => 1.2m * parcel.WeightInKg;
}

internal sealed class Checkout(IShippingCostStrategy shippingCost)
{
    public decimal Total(Order order) => order.Subtotal + shippingCost.Compute(order.Parcel);
}
```

Three roles: the **strategy** interface, the **concrete strategies**, and the **context** (`Checkout`) that receives one and calls it. In .NET, the dependency injection container usually does the handing over.


## The problem: turning a change into activity lines
In the project-management app, an issue raises an `IssueUpdatedDomainEvent` when it is saved. It is a "fat" event: for each property, it carries the value before and after the change, typed as a `PropertyValueChange<T>` from the shared kernel:

```csharp
namespace Blouppy.SharedKernel.Entities;

public record PropertyValueChange<TProperty>(TProperty OldValue, TProperty NewValue)
{
    public static implicit operator PropertyValueChange<TProperty>(
        (TProperty OldValue, TProperty NewValue) change)
        => new(change.OldValue, change.NewValue);
}
```

The implicit conversion from a tuple keeps the aggregate readable when it raises the event:

```csharp
AddDomainEvent(new IssueUpdatedDomainEvent(
    id: Id,
    // name, description, position...
    projectStatusId: (OldValue: ProjectStatusId, NewValue: projectStatusId),
    assigneeId: (OldValue: AssigneeId, NewValue: assigneeId),
    priority: (OldValue: Priority, NewValue: priority),
    milestoneId: (OldValue: MilestoneId, NewValue: milestoneId),
    labelIds: (OldValue: Labels.Select(x => x.LabelId).ToArray(), NewValue: labelIds)));
```

What the history stores is an `Activity`: which issue, what happened, to which field, and the old and new values **as text**, the way the page showed them at that moment:

```csharp
public sealed class Activity(
    IssueId issueId,
    ActivityType activityType,
    ActivityField activityField,
    string? oldValue,
    string? newValue,
    ScopeMoveReason? reason = null) : CreatedAtEntityBase<ActivityId>
{
    // ...
}

public enum ActivityType
{
    Added = 0,
    Removed = 1,
    Updated = 2,
}
```

`ActivityField` lists the tracked fields: `Status`, `Assignee`, `Priority`, `Label`, `Milestone`, and a few more for relations between issues. So the job is: from a `PropertyValueChange<T>`, decide whether something happened, whether it was added, removed or changed, and what text to keep. Each field answers differently.


## One strategy per field
The strategy interface is generic on the type of the property:

```csharp
namespace Blouppy.Issues.Activities.ActivityStrategies;

internal interface IChangeActivityStrategy<TProperty>
{
    Task<IReadOnlyCollection<Activity>> GetChangeActivitiesAsync(
        IssueId issueId,
        PropertyValueChange<TProperty> propertyValueChange,
        CancellationToken cancellationToken);
}
```

It returns a collection because a field can produce zero, one or several lines. Here is the simplest strategy, the priority, which needs nothing but the values:

```csharp
internal sealed class PriorityActivityStrategy : IChangeActivityStrategy<Priority?>
{
    public Task<IReadOnlyCollection<Activity>> GetChangeActivitiesAsync(
        IssueId issueId,
        PropertyValueChange<Priority?> priority,
        CancellationToken cancellationToken)
    {
        IReadOnlyCollection<Activity> activities = priority switch
        {
            { OldValue: null, NewValue: not null } =>
                [new Activity(issueId, ActivityType.Added, ActivityField.Priority, string.Empty, $"{priority.NewValue}")],
            { OldValue: not null, NewValue: null } =>
                [new Activity(issueId, ActivityType.Removed, ActivityField.Priority, $"{priority.OldValue}", string.Empty)],
            { OldValue: not null, NewValue: not null } when priority.OldValue != priority.NewValue =>
                [new Activity(issueId, ActivityType.Updated, ActivityField.Priority, $"{priority.OldValue}", $"{priority.NewValue}")],
            _ => []
        };

        return Task.FromResult(activities);
    }
}
```

A property pattern on the old and new values maps directly to the three activity types: no value before means "added", no value after means "removed", two different values mean "changed". The other strategies keep that shape and add what their field needs:

- **`AssigneeActivityStrategy`** (`UserId?`) does the same three-way match, but stores the person's name. It asks the Users domain through `IUsersPublicDataService`, since another domain's data is only reachable through its public contract.
- **`ProjectStatusActivityStrategy`** (`ProjectStatusId`) always has a value, so it only ever writes "updated", with the new status's name fetched from the Projects domain.
- **`MilestoneActivityStrategy`** (`MilestoneId?`) fetches both names at once. A milestone deleted since the change has no name left, and that side then reads as empty:

```csharp
var activityType = (oldName, newName) switch
{
    ("", "") => (ActivityType?)null,
    ("", _) => ActivityType.Added,
    (_, "") => ActivityType.Removed,
    _ => ActivityType.Updated
};
```

- **`LabelsActivityStrategy`** (`IReadOnlyCollection<LabelId>`) is the only one that compares sets. It computes the removed and added ids with `Except`, fetches all their names in one call to the Workspaces domain, and writes at most two lines: one "removed" with the removed names joined by commas, one "added" with the added ones.

Each class has its own dependencies. The priority strategy has none, the labels strategy needs Workspaces, the status and milestone strategies need Projects. In a single method with a `switch`, all of these would be injected into one class, and every test of the priority logic would have to set up mocks it never uses.


## The context: a factory that calls them all
The context is `ActivityFactory`. Its constructor asks for one strategy per closed generic type:

```csharp
internal sealed class ActivityFactory(
    IChangeActivityStrategy<ProjectStatusId> projectStatusChangeActivityStrategy,
    IChangeActivityStrategy<UserId?> assigneeChangeActivityStrategy,
    IChangeActivityStrategy<Priority?> priorityChangeActivityStrategy,
    IChangeActivityStrategy<MilestoneId?> milestoneChangeActivityStrategy,
    IChangeActivityStrategy<IReadOnlyCollection<LabelId>> labelsChangeActivityStrategy) : IActivityFactory
{
    public async Task<IReadOnlyCollection<Activity>> CreateAsync(
        IssueUpdatedDomainEvent domainEvent,
        CancellationToken cancellationToken)
        =>
        [
            .. HillPositionActivities(domainEvent),
            .. await projectStatusChangeActivityStrategy.GetChangeActivitiesAsync(domainEvent.Id, domainEvent.ProjectStatusId, cancellationToken),
            .. await assigneeChangeActivityStrategy.GetChangeActivitiesAsync(domainEvent.Id, domainEvent.AssigneeId, cancellationToken),
            .. await priorityChangeActivityStrategy.GetChangeActivitiesAsync(domainEvent.Id, domainEvent.Priority, cancellationToken),
            .. await milestoneChangeActivityStrategy.GetChangeActivitiesAsync(domainEvent.Id, domainEvent.MilestoneId, cancellationToken),
            .. await labelsChangeActivityStrategy.GetChangeActivitiesAsync(domainEvent.Id, domainEvent.LabelIds, cancellationToken)
        ];
}
```

The registration maps each closed type to its class:

```csharp
services
    .AddScoped<IActivityFactory, ActivityFactory>()
    .AddScoped<IChangeActivityStrategy<ProjectStatusId>, ProjectStatusActivityStrategy>()
    .AddScoped<IChangeActivityStrategy<UserId?>, AssigneeActivityStrategy>()
    .AddScoped<IChangeActivityStrategy<Priority?>, PriorityActivityStrategy>()
    .AddScoped<IChangeActivityStrategy<IReadOnlyCollection<LabelId>>, LabelsActivityStrategy>()
    .AddScoped<IChangeActivityStrategy<MilestoneId?>, MilestoneActivityStrategy>();
```

This is where generics do the selection. `IChangeActivityStrategy<Priority?>` and `IChangeActivityStrategy<UserId?>` are two different types for the container, so each constructor parameter receives exactly one strategy, with no key and no lookup. The compiler checks the rest: `domainEvent.Priority` is a `PropertyValueChange<Priority?>`, and passing it to the assignee strategy does not compile.

A domain event handler, `CreateActivitiesWhenIssueUpdatedDomainEventHandler`, calls `CreateAsync` and saves what comes back through `IActivitiesRepository` when the list is not empty.

This is a variation on the textbook pattern. The classic Strategy swaps one algorithm for another; here the factory runs every strategy on each event, and the generic type decides which algorithm handles which field. What it keeps from the pattern is the point that matters: one interface, one class per variant, and a context that only knows the interface.


## Not everything needs a strategy
The factory also holds one rule as a private method. In a Shape Up project, a scope's position on the hill can move on its own when its issues move. Only that automatic move is logged, with its reason:

```csharp
private static IReadOnlyCollection<Activity> HillPositionActivities(IssueUpdatedDomainEvent domainEvent)
    => domainEvent is { AutomaticMoveReason: { } reason }
       && domainEvent.Progress.OldValue != domainEvent.Progress.NewValue
        ?
        [
            new Activity(
                domainEvent.Id,
                ActivityType.Updated,
                ActivityField.HillPosition,
                $"{domainEvent.Progress.OldValue ?? 0}",
                $"{domainEvent.Progress.NewValue ?? 0}",
                reason)
        ]
        : [];
```

It needs no dependency and reads two properties of the event, so a class, an interface and a registration would add nothing. The same goes for relations between issues: `IssueRelationActivities` is a static class with two `switch` expressions, one mapping the relation kind to a pair of fields ("blocks" and "is blocked by"), the other mapping added or removed to the old or new value. The cases are closed, the logic is a few lines, and nothing needs to be injected.

A `switch` expression is enough when the variants are few, short, need no dependencies of their own, and are unlikely to grow. A strategy pays off when a variant has its own collaborators, its own edge cases, and tests of its own.


## Adding a tracked field
Say the app starts tracking a new field. The steps are:

1. The event already carries it as a `PropertyValueChange<T>`, or gets a new property.
2. Add a value to `ActivityField`. The enum has explicit numbers because they are stored: a removed field keeps its number as a comment so it is never reused.
3. Write the strategy class, implementing `IChangeActivityStrategy<T>` for the field's type.
4. Register it, and add one line to `ActivityFactory`.
5. Write its tests.

No existing strategy changes, which is the open/closed principle from [SOLID](/blog/2022-02-28-introduction-to-solid-principles/) at work. The factory does change by one line, and that is a fair price for seeing every tracked field in one place.

There is a limit to selecting by type. If the new field were a second user, a reviewer typed `UserId?`, the container could no longer tell it from the assignee: both would be `IChangeActivityStrategy<UserId?>`. The fix is to make the type say more (a dedicated `ReviewerId`) or to use [keyed services](https://learn.microsoft.com/dotnet/core/extensions/dependency-injection#keyed-services), registered with `AddKeyedScoped` and injected with `[FromKeyedServices]`.


## Testing a strategy alone
Because each strategy is a small class, its tests are small too. The priority strategy has no dependency, so the test creates it with `new()` and passes a tuple, which the implicit operator turns into a `PropertyValueChange<Priority?>`:

```csharp
public sealed class PriorityActivityStrategyTests
{
    private readonly IFixture _fixture = new Fixture();

    private readonly PriorityActivityStrategy _sut = new();

    [Fact]
    public async Task Should_return_added_Activity_when_Priority_has_been_added()
    {
        // Arrange
        var issueId = _fixture.Create<IssueId>();
        var priorityChange = (OldValue: (Priority?)null, NewValue: Priority.Medium);

        // Act
        var activities = await _sut.GetChangeActivitiesAsync(issueId, priorityChange, TestContext.Current.CancellationToken);

        // Assert
        var expectedActivities = new List<Activity>
        {
            new(issueId, ActivityType.Added, ActivityField.Priority, string.Empty, $"{priorityChange.NewValue}")
        };

        activities
            .Should()
            .BeEquivalentTo(expectedActivities);
    }
}
```

The labels strategy's tests mock only `IWorkspacesPublicDataService`, and cover set cases (one added, one removed, both, none) without touching priorities or milestones. The factory's own tests mock the five strategies, so they check how the factory combines their results without exercising any field's rules.


## A strategy chosen once, at startup
The second example is the classic shape. In [Blouppy Starter](https://starter.blouppy.com/), files go through a port, `IFileStorage` (`SaveAsync`, `TryOpenReadAsync`, `DeleteAsync`, `DeleteFolderAsync`), with two implementations: `LocalDiskFileStorage` and `S3FileStorage`. The registration reads `FileStorage:Provider` and registers one of them:

```csharp
var provider = section.GetValue(nameof(FileStorageOptions.Provider), FileStorageProvider.LocalDisk);

if (provider == FileStorageProvider.S3)
{
    services
        .AddSingleton<IAmazonS3>(serviceProvider => CreateClient(
            serviceProvider.GetRequiredService<IOptions<FileStorageOptions>>().Value.S3))
        .AddSingleton<IFileStorage, S3FileStorage>();
}
else
{
    services.AddSingleton<IFileStorage, LocalDiskFileStorage>();
}
```

The choice is made once, when the host starts, and every caller receives the same `IFileStorage` for the life of the process. The S3 client is not even registered when the disk is chosen. Changing the provider means changing the configuration and restarting.

The activity log is the other end: every strategy is present, and the field decides which one handles which value. Between the two sits the per-call choice, where the right strategy depends on the request (a payment method, a file format). That one is usually an `IEnumerable<IStrategy>` where each strategy says what it handles, or keyed services resolved by a key known at runtime.


## What it costs
- **More files.** Five strategies, five test classes and a registration block replace one method.
- **Indirection.** Reading the factory does not tell what a priority change writes; we have to open the strategy.
- **A registration to forget.** A strategy that is written but not registered compiles, and fails when the container first builds the factory.
- **Selection by type has limits**, as the second `UserId?` field shows.

For three fields that turn a value into a string, that cost is too high. For fields that each talk to a different domain and have their own edge cases, it is what keeps each rule small enough to read and test.


## Conclusion
The Strategy pattern puts each variant of an algorithm behind one interface. In the issue activity log, `IChangeActivityStrategy<T>` gives each field its own class, `PropertyValueChange<T>` carries the before and after values, and the generic type lets the container and the compiler pick the right strategy without a lookup. Rules that are short and dependency-free stay in a private method or a `switch` expression next to it. The file storage of [Blouppy Starter](https://starter.blouppy.com/) shows the classic form: one strategy, picked by configuration, once.


## References

- [Design Patterns: Elements of Reusable Object-Oriented Software](https://www.pearson.com/en-us/subject-catalog/p/design-patterns-elements-of-reusable-object-oriented-software/P200000009480) — the Gang of Four book that names the Strategy pattern.
- [Strategy](https://refactoring.guru/design-patterns/strategy) — Refactoring.Guru: the pattern's structure and trade-offs, with C# examples.
- [Dependency injection in .NET](https://learn.microsoft.com/dotnet/core/extensions/dependency-injection) — Microsoft Learn: service registration, open and closed generics, and keyed services.
- [Pattern matching](https://learn.microsoft.com/dotnet/csharp/fundamentals/functional/pattern-matching) — Microsoft Learn: the property and tuple patterns the strategies use.
- [Introduction to SOLID principles](/blog/2022-02-28-introduction-to-solid-principles/) — the open/closed principle the strategies follow.
- [Hexagonal architecture in .NET](/blog/2026-05-04-hexagonal-architecture-in-dotnet/) — the `.PublicData` contracts the strategies call and the `IFileStorage` port.
