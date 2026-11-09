---
templateKey: 'blog-post'
title: 'Aggregates in C#: an issue that guards its own rules'
date: 2026-12-08T09:00:00.000Z
author: Jimmy Boinembalome
authorimage: /img/jimmy.jpg
category: C#
topic: 'Architecture'
illustration: 3
categorycolor: bg-purple-100 text-purple-800
featuredpost: true
description: >-
  Learn the DDD aggregate in C#: methods instead of setters, a boundary drawn by id, what it costs in tests and EF Core, and when plain getters and setters are enough.
tags:
  - Development
  - C#
  - Design Patterns
  - DDD
  - EF Core
---

An issue tracker starts with a class full of `{ get; set; }`. A controller sets `Status`, a background job sets `Progress`, an import sets `ParentIssueId`. Each of them remembers, or forgets, to write the activity line, notify the assignee and refuse an issue that is its own parent. The rules exist, but they live in every caller, and the next caller copies the closest one.

An aggregate moves those rules into the object they protect.


## The pattern
Eric Evans' _Domain-Driven Design_ describes an aggregate as a cluster of objects treated as one unit for data changes. One entity, the **root**, is the only way in. What sits inside its **boundary** changes together, in one transaction; what sits outside is referenced **by id**. And the root checks the **invariants**, the rules that must hold whenever the aggregate is saved, because every change goes through it.

An order shows the shape:

```csharp
public sealed class Order
{
    private readonly List<OrderLine> _lines = [];

    public Order(CustomerId customerId)
        => CustomerId = customerId;

    public CustomerId CustomerId { get; private set; }
    public bool IsSubmitted { get; private set; }
    public IReadOnlyCollection<OrderLine> Lines => _lines.AsReadOnly();

    public void AddLine(ProductId productId, int quantity)
    {
        if (IsSubmitted)
        {
            throw new InvalidOperationException("A submitted order cannot change.");
        }

        ArgumentOutOfRangeException.ThrowIfNegativeOrZero(quantity);

        _lines.Add(new OrderLine(productId, quantity));
    }

    public void Submit()
    {
        if (_lines.Count == 0)
        {
            throw new InvalidOperationException("An empty order cannot be submitted.");
        }

        IsSubmitted = true;
    }
}
```

`OrderLine` is inside: nobody adds one without asking the order. `CustomerId` and `ProductId` point outside: the order does not load a customer to be valid. The private setters enforce "every change goes through the root", because the compiler refuses any other path.


## An issue that guards its own rules
A project-management app built on [Blouppy Starter](https://starter.blouppy.com/) applies the same shape to its `Issue`. The constructor refuses an issue that could not exist, and every property has a private setter. Changes are methods named after what happens on the board: `Update`, `Move`, `Reparent`, `MarkAsDeleted`.

Each method decides what is announced. `Move` raises an `IssueMovedDomainEvent` only when the position or the status changed. `Update` raises an event that carries the old and new value of every field. The activity feed, the notifications and the webhooks read those events, so no caller can change a field and skip them. How the events are dispatched in the same transaction is covered in [domain events vs integration events](/blog/2026-05-28-domain-events-vs-integration-events-and-the-outbox/).

`Reparent` guards the one rule it can check alone:

```csharp
public void Reparent(IssueId? parentIssueId)
{
    if (parentIssueId is not null && parentIssueId == Id)
    {
        throw new ArgumentException("An issue cannot be its own parent.", nameof(parentIssueId));
    }

    if (parentIssueId != ParentIssueId)
    {
        AddDomainEvent(new IssueReparentedDomainEvent(
            id: Id,
            projectStatusId: ProjectStatusId,
            parentIssueId: (OldValue: ParentIssueId, NewValue: parentIssueId)));
    }

    ParentIssueId = parentIssueId;
}
```

The other rules about a parent, "a root in the same project" and "this issue has no children", need other rows. The caller checks them. Only the invariant that needs no lookup lives in the method, and saying so is the most useful thing an aggregate can tell its reader.


## Where the boundary runs
What is inside the `Issue` aggregate is small: its labels, reachable only through a read-only collection over a private list. Everything else is referenced by id: the parent, the status, the assignee. Comments and activities are entities of their own, each holding an `IssueId`, so loading an issue never loads its comments.

A rule that crosses issues cannot live in one of them. In a Shape Up project, a scope's position on the hill is computed from its issues. A domain service loads the scope and its issues, computes the target, and asks the scope to move through its own method. Vaughn Vernon's rule of thumb is to change one aggregate per transaction. Here the scope changes in the same unit of work as its issue, on purpose, so that both commit or neither does. The rule exists to keep transactions small, and this one stays small.

Automatic writes are where setters usually come back. When a merged pull request asks for an issue to change status, the handler does not touch the entity. It acts as the system actor and calls the same service a person would. A rule added to the aggregate next year applies to the merge as well, because there is no second path.


## The price of private setters
**Test data is painful.** A test that needs an issue with a given id cannot set it. The code base copes with a reflection helper, `SetProperty`, that writes through a private setter or a backing field. It works, but it bypasses the very rules the aggregate exists for. Test builders that replay real method calls are cleaner, and longer to write.

**EF Core needs a way in.** The constructor takes label ids, which are not a column, so EF Core cannot bind to it. Every aggregate carries a private parameterless constructor "Required for EF", and collections need a backing field EF Core can find.

**Ceremony.** `Update` takes nine arguments, and a caller that changes only the status passes the other fields back unchanged. Each new field touches the constructor, `Update`, the event and every caller.

**Loading the whole aggregate.** Changing one field means loading the issue and its labels. For bulk changes, the code base steps outside with `ExecuteUpdateAsync`: one SQL statement, no entity loaded, no domain event. That is right when nothing listens, and a silent hole when something later starts to.


## When getters and setters are enough
An aggregate pays off when there are rules to protect. A read model built by a query and never changed has nothing to guard. A settings row with one time zone gains nothing from a method a setter could replace. A CRUD screen where any field may take any value is the same.

A useful test: write down the rule the method would enforce. If the sentence is "the value is not empty", a validator and a setter will do. If it is "a submitted order cannot change" or "an issue cannot be its own parent", reach for the aggregate. The same code base can hold both styles side by side.


## References
- [DDD Aggregate (Martin Fowler)](https://martinfowler.com/bliki/DDD_Aggregate.html) — a short definition of the pattern.
- [Effective Aggregate Design (Vaughn Vernon)](https://www.dddcommunity.org/library/vernon_2011/) — the essays on small aggregates and references by id.
- [Backing fields (EF Core)](https://learn.microsoft.com/ef/core/modeling/backing-field) — how EF Core maps a private field behind a property.
- [Domain events vs integration events in .NET, and the transactional outbox](/blog/2026-05-28-domain-events-vs-integration-events-and-the-outbox/) — how the events an aggregate raises are dispatched.
