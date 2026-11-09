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

An issue tracker keeps a history: "Alice changed the priority from Low to High", "Bob removed the label Bug". The first version is one method with a `switch` on the field. Then each field grows its own rules, and every new field means editing that method again.

The Strategy pattern gives each of those rules a class of its own.


## The pattern
The Strategy pattern puts each variant of an algorithm in its own class, behind one interface, so the code that calls it does not know which variant it holds. Shipping costs are the textbook case:

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

`Checkout` is the **context**: it receives a strategy, usually from the dependency injection container, and calls it. Adding a pick-up point option is a new class; `Checkout` does not change.


## One class per field
A project-management app built on [Blouppy Starter](https://starter.blouppy.com/) uses the same idea for its issue history. When an issue is saved, its domain event carries the old and new value of each field as a `PropertyValueChange<T>`. Each field has a strategy that turns that change into activity lines:

```csharp
internal interface IChangeActivityStrategy<TProperty>
{
    Task<IReadOnlyCollection<Activity>> GetChangeActivitiesAsync(
        IssueId issueId,
        PropertyValueChange<TProperty> change,
        CancellationToken cancellationToken);
}

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

The priority needs nothing but its two values. The other fields need more: the assignee strategy looks up the person's name in the Users domain, the labels strategy compares two sets and fetches label names from Workspaces. Each class injects only what its own field needs, so a test of the priority rule sets up no mock at all.

The context runs every strategy on each event. Since `IChangeActivityStrategy<Priority?>` and `IChangeActivityStrategy<UserId?>` are different types, the container hands each constructor parameter exactly one strategy, without a key or a lookup:

```csharp
internal sealed class ActivityFactory(
    IChangeActivityStrategy<Priority?> priority,
    IChangeActivityStrategy<UserId?> assignee,
    IChangeActivityStrategy<IReadOnlyCollection<LabelId>> labels) : IActivityFactory
{
    public async Task<IReadOnlyCollection<Activity>> CreateAsync(
        IssueUpdatedDomainEvent domainEvent,
        CancellationToken cancellationToken)
        =>
        [
            .. await priority.GetChangeActivitiesAsync(domainEvent.Id, domainEvent.Priority, cancellationToken),
            .. await assignee.GetChangeActivitiesAsync(domainEvent.Id, domainEvent.AssigneeId, cancellationToken),
            .. await labels.GetChangeActivitiesAsync(domainEvent.Id, domainEvent.LabelIds, cancellationToken)
        ];
}
```

The compiler checks the wiring too: passing `domainEvent.Priority` to the assignee strategy does not compile. The limit shows up with a second field of the same type. A reviewer typed `UserId?` would be indistinguishable from the assignee, and would need its own type or a [keyed service](https://learn.microsoft.com/dotnet/core/extensions/dependency-injection#keyed-services).


## When a switch is enough
The pattern costs a class, a registration and a test file per variant, plus one more hop when reading the code. For variants that are short, closed and need no dependency, a `switch` expression next to the caller is clearer. The same factory keeps one rule that way, a private method that reads two properties of the event.

A strategy pays off when each variant has its own collaborators, its own edge cases and its own tests. The issue history has all three, which is why each field ended up in its own class.


## References

- [Strategy](https://refactoring.guru/design-patterns/strategy) — Refactoring.Guru: the pattern's structure and trade-offs.
- [Dependency injection in .NET](https://learn.microsoft.com/dotnet/core/extensions/dependency-injection) — Microsoft Learn: closed generics and keyed services.
- [Pattern matching](https://learn.microsoft.com/dotnet/csharp/fundamentals/functional/pattern-matching) — Microsoft Learn: the property patterns the strategies use.
- [Introduction to SOLID principles](/blog/2022-02-28-introduction-to-solid-principles/) — the open/closed principle behind the pattern.
