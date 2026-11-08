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

An issue tracker starts with a class full of `{ get; set; }`. A controller sets `Status`, a background job sets `Progress`, an import sets `ParentIssueId`, and each of them remembers, or forgets, to write the activity line, notify the assignee and refuse an issue that is its own parent. The rules exist, but they live in every caller, and the next caller copies the closest one.

In this article, we will look at the **aggregate**, a pattern from Eric Evans' _Domain-Driven Design_. We will see its shape on a small example, then a real one: the `Issue` of a project-management app built on [Blouppy Starter](https://starter.blouppy.com/). Then we will spend as long on what it costs, in tests and in EF Core, and on the cases where plain getters and setters are the better choice.


## The pattern
Evans describes an aggregate as a cluster of objects treated as one unit for data changes. It has three parts:

- **A root.** One entity is the only way in. Outside code holds a reference to the root, never to an object inside.
- **A boundary.** What is inside changes together, in one transaction. What is outside is referenced **by id**.
- **Invariants.** The rules that must hold whenever the aggregate is saved. The root checks them, because every change goes through it.

Here is the shape on a generic order:

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

`OrderLine` is inside: nobody adds one without asking the order. `CustomerId` and `ProductId` point outside: the order does not load a customer to be valid. The private setters are what enforce "every change goes through the root": the compiler refuses any other path.


## The building blocks
Blouppy Starter gives every aggregate the same base classes in `Blouppy.SharedKernel`. The root records its domain events:

```csharp
public abstract class HasDomainEventsBase
{
    private readonly List<IDomainEvent> _domainEvents = [];

    [NotMapped]
    public IReadOnlyCollection<IDomainEvent> DomainEvents => _domainEvents.AsReadOnly();

    protected void AddDomainEvent(IDomainEvent domainEvent)
        => _domainEvents.Add(domainEvent);

    internal void ClearDomainEvents() => _domainEvents.Clear();
}
```

`EntityBase<TId>` adds a strongly typed `Id`, and `AuditableEntityBase<TId>` adds `CreatedBy`, `CreatedDate`, `LastModifiedBy` and `LastModifiedDate`. Those base properties have **public** setters: the database generates the id and a save-changes interceptor stamps the audit fields. That is a deliberate compromise, and we will meet its consequence in the tests. How the events are dispatched in the same transaction is covered in [domain events vs integration events](/blog/2026-05-28-domain-events-vs-integration-events-and-the-outbox/), and the ids in [strongly typed IDs with EF Core](/blog/2026-05-16-strongly-typed-ids-with-ef-core/).


## An issue that guards its own rules
The `Issue` of the project-management app is an `AuditableEntityBase<IssueId>`. Its constructor refuses an issue that could not exist, and every property has a private setter:

```csharp
public Issue(
    NumberIdentifier numberIdentifier,
    string name,
    string? description,
    double position,
    ProjectStatusId projectStatusId,
    UserId? assigneeId,
    Priority? priority,
    int? progress,
    IssueId? parentIssueId,
    IReadOnlyCollection<LabelId> labelIds)
{
    _labels = labelIds
        .Distinct()
        .Select(labelId => new IssueLabel { IssueId = Id, LabelId = labelId })
        .ToList();

    NumberIdentifier = Exceptions.ThrowIfNullOrNegativeOrZero(numberIdentifier);
    Name = Exceptions.ThrowIfNullOrWhiteSpace(name);
    Position = Exceptions.ThrowIfNullOrNegativeOrZero(position);
    ProjectStatusId = Exceptions.ThrowIfNullOrNegativeOrZero(projectStatusId);
    // ...the optional fields are assigned as given
}
```

Changes are methods named after what happens on the board: `Update`, `Move`, `Reposition`, `Reparent`, `MarkAsCreated`, `MarkAsDeleted`. Each one decides what is announced. A move inside a column raises an event only when something changed:

```csharp
public void Move(double position, ProjectStatusId projectStatusId)
{
    if (position != Position || projectStatusId != ProjectStatusId)
    {
        AddDomainEvent(new IssueMovedDomainEvent(
            id: Id,
            projectStatusId: (OldValue: ProjectStatusId, NewValue: projectStatusId),
            position: (OldValue: Position, NewValue: position)));
    }

    Position = position;
    ProjectStatusId = projectStatusId;
}
```

`Reposition` rewrites the position when the gaps between neighbours run out of precision. The order on the board does not change, so it raises nothing. `Update` raises an `IssueUpdatedDomainEvent` carrying the old and new value of every field, plus an `IssueDescriptionReplacedDomainEvent` when the description changed. The activity feed, the notifications and the webhooks read those events, so no caller can change a field and skip them.

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

The other rules about a parent, "a root in the same project" and "this issue has no children", need other rows. The method's comment says so: the caller has checked them, and only the invariant that needs no lookup lives here. That honesty is the most useful thing an aggregate can tell its reader.


## Where the boundary runs
What is inside the `Issue` aggregate is small:

- **Labels.** `IssueLabel` rows are only reachable through `Labels`, an `IReadOnlyCollection<IssueLabel>` over the private `_labels` list. `Update` diffs them. EF Core maps the navigation to that backing field by its naming convention.

Everything else is **referenced by id**: the parent (`ParentIssueId`), the milestone, the status, the assignee. Comments, activities, attachments and the hill's daily `HillPosition` rows are entities of their own, each holding an `IssueId`. The EF configuration declares those relations without any navigation on `Issue`, so loading an issue never loads its comments.

The interesting consequence is the rule that crosses issues. In a Shape Up project, a scope's position on the hill is computed from its issues. That rule reads several aggregates, so it cannot live in one. It lives in a domain service, `ParentIssueRollup`, called by the issues service after every write to a sub-issue. It loads the parent and its sub-issues, computes the target, and asks the parent to move through its own method:

```csharp
public void FollowTasks(int progress, ProjectStatusId projectStatusId, double position, ScopeMoveReason reason)
{
    Exceptions.ThrowIfNullOrNegativeOrZero(Id);
    Exceptions.ThrowIf(progress, x => x is < 0 or > 100, "A position on the hill is between 0 and 100.");

    if (progress == Progress && projectStatusId == ProjectStatusId)
    {
        return;
    }

    AddDomainEvent(new IssueUpdatedDomainEvent(/* old and new values */)
    {
        AutomaticMoveReason = reason
    });

    Progress = progress;
    ProjectStatusId = projectStatusId;
    Position = position;
}
```

Vaughn Vernon's rule of thumb is to change one aggregate per transaction. Here the parent changes in the same unit of work as its sub-issue, on purpose, so that both commit or neither does. It is a reasonable bend of the rule: the rule's purpose is to keep transactions small and contention low, and a parent with its few sub-issues stays small.


## The system actor goes through the same door
Automatic writes are where hand-written setters usually come back. A pull request merged on the code host asks for an issue to change status. The handler of that integration event does not touch the entity directly: it opens an actor scope and calls the same service a person would.

```csharp
using var _ = actorScope.ActAsExternalIntegration();

var result = await issuesService.TryChangeStatusAsync(
    new IssueStatusEdition(@event.IssueId, @event.StatusId),
    cancellationToken);
```

The validator runs, `Update` raises its events, the activity names the system actor, and the scope above the issue follows. A rule added to the aggregate next year applies to the merge as well, because there is no second path.


## A smaller aggregate in the Starter
Blouppy Starter's `Team` shows the same shape with one real invariant. A team can take its members from a directory group of the organization's identity provider. While it does, the members cannot be edited by hand:

```csharp
public void Update(string name, IReadOnlyCollection<UserId> memberIds, WorkspaceId workspaceId)
{
    Exceptions.ThrowIfNullOrNegativeOrZero(Id);

    if (IsLinkedToDirectoryGroup && !HasMembers(memberIds))
    {
        throw new InvalidOperationException($"Team ({Id}) takes its members from directory group ({DirectoryGroupId}).");
    }

    Name = Exceptions.ThrowIfNullOrWhiteSpace(name);
    WorkspaceId = Exceptions.ThrowIfNullOrNegativeOrZero(workspaceId);

    UpdateMembers(memberIds);
}
```

`TeamMember` rows are inside, behind a private list; the workspace and the users are ids. `LinkToDirectoryGroup`, `SyncDirectoryGroupMembers` and `UnlinkDirectoryGroup` are the only other ways to change the members. Whether the change comes from the settings page or from the identity provider's SCIM sync, it goes through one of these methods.


## What it costs
The benefits are real, and so is the bill.

**Test data is painful.** A test that needs an issue with a given id or progress cannot set it. The code base copes with a reflection helper, `SetProperty`, in its shared test helpers. It sets the property through its setter, private or not, or through a `_camelCase` backing field:

```csharp
private Issue Given_an_issue_on_edition(IssueId? parentIssueId = null)
{
    var issue = Given_an_issue_on_creation(parentIssueId);

    issue.SetProperty(x => x.Id, _fixture.Create<IssueId>());

    return issue;
}
```

`Given_an_issue_on_creation` calls the ten-argument constructor with AutoFixture values. The database tests do the same in `IssueDataSeed`: a `BuildIssue` helper calls the constructor, and helpers such as `Given_an_Issue_without_Priority` or `Given_an_unassigned_Issue` fix a field afterwards with `SetProperty`. `DatabaseEntityFixture` adds an AutoFixture builder that omits `Id` and the audit fields, so the database and the interceptor fill them. It works, but reflection is a bypass of the very rules the aggregate exists for, renaming a field breaks it at run time, and a test can build a state the domain never could. The alternative, test builders that replay real method calls, is cleaner and longer to write.

**EF Core needs a way in.** The constructor takes `labelIds`, which is not a column, so EF Core cannot bind to it. Every aggregate carries a private parameterless constructor marked "Required for EF" and a `#pragma warning disable CS8618` for the non-nullable properties it leaves empty. Collections need a backing field that EF Core can find.

**Ceremony.** `Update` takes nine arguments. `ParentIssueRollup`, which only wants to change the status and the progress, passes the name, description, assignee, priority, milestone and labels back unchanged. Each new field touches the constructor, `Update`, the event and every caller.

**Loading the whole aggregate.** Changing one field means loading the issue and its labels, then saving it. For bulk changes the code base steps outside the aggregate: transferring project ownership or marking every notification as read uses EF Core's `ExecuteUpdateAsync`, one SQL statement, no entity loaded and no domain event raised. That is the right call when nothing listens, and a silent hole when something later starts to.

**Aggregates that grow.** Putting comments inside `Issue` would look natural, and would turn every status change into a load of every comment. The boundary has to be drawn small and kept small.


## When getters and setters are enough
An aggregate pays off when there are rules to protect. Without rules, it is ceremony. Plain properties are enough for:

- **Read models.** Blouppy Starter's `DetailedOrganizationMember` is a record with `required` `init` properties. It is built by a query and never changed, so there is nothing to guard.
- **Settings and preferences.** `UserSettings` holds one time zone, and its `Update` method does nothing a setter could not. The validator already checks the value.
- **CRUD screens.** A list of tags, a webhook's description: any field may change to any value, and nothing else depends on it.
- **Rows inside an aggregate.** `IssueLabel` and `TeamMember` have public setters. Only their root can reach them, so the root's boundary protects them.

A useful test: write down the rule the method would enforce. If the sentence is "the value is not empty", a validator and a setter will do. If it is "a submitted order cannot change" or "a team linked to a directory group keeps its members", reach for the aggregate. It depends on the context, and the same code base can hold both styles side by side.


## Conclusion
An aggregate puts a cluster of objects behind one root, changes them through methods named after what happens, and references everything else by id. In the project-management app, that makes the issue the only place that decides what a move announces, and makes the system actor follow the same rules as a person. It costs reflection in the tests, extra constructors for EF Core, long methods and full loads. Use it where there is an invariant to protect, and keep plain properties for read models, settings and data with no rule.

`HasDomainEventsBase`, `AuditableEntityBase` and `Team` are in [Blouppy Starter](https://starter.blouppy.com/).


## References
- [Domain-Driven Design: Tackling Complexity in the Heart of Software (Eric Evans)](https://www.domainlanguage.com/ddd/) — the book that defines aggregates, roots and boundaries.
- [DDD Aggregate (Martin Fowler)](https://martinfowler.com/bliki/DDD_Aggregate.html) — a short definition of the pattern.
- [Effective Aggregate Design (Vaughn Vernon)](https://www.dddcommunity.org/library/vernon_2011/) — the essays on small aggregates and references by id.
- [Design a microservice domain model (Microsoft Learn)](https://learn.microsoft.com/dotnet/architecture/microservices/microservice-ddd-cqrs-patterns/microservice-domain-model) — aggregates in .NET, with private setters and backing fields.
- [Backing fields (EF Core)](https://learn.microsoft.com/ef/core/modeling/backing-field) — how EF Core maps a private field behind a property.
- [Entity types with constructors (EF Core)](https://learn.microsoft.com/ef/core/modeling/constructors) — when EF Core can bind a constructor, and when it needs another.
- [ExecuteUpdate and ExecuteDelete (EF Core)](https://learn.microsoft.com/ef/core/saving/execute-insert-update-delete) — bulk updates that skip the change tracker.
- [Domain events vs integration events in .NET, and the transactional outbox](/blog/2026-05-28-domain-events-vs-integration-events-and-the-outbox/) — how the events an aggregate raises are dispatched.
- [Strongly typed IDs with EF Core](/blog/2026-05-16-strongly-typed-ids-with-ef-core/) — the ids an aggregate uses to point outside its boundary.
