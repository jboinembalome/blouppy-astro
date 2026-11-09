---
templateKey: 'blog-post'
title: 'Do you still need a repository on top of EF Core?'
date: 2026-12-01T09:00:00.000Z
author: Jimmy Boinembalome
authorimage: /img/jimmy.jpg
category: C#
topic: 'Architecture'
illustration: 1
categorycolor: bg-purple-100 text-purple-800
featuredpost: true
description: >-
  Learn what the Repository pattern adds on top of EF Core's DbContext, why the generic repository usually fails, and when a specific port per aggregate is worth its cost.
tags:
  - Development
  - C#
  - Design Patterns
  - DDD
  - EF Core
---

Every few months, the same discussion comes back: "EF Core already is a repository, so wrapping it in another one is pointless." The other camp answers that a domain should never see `DbContext`. Both are right about something. Most of the disagreement comes from talking about two different repositories: the generic one that wraps a table, and the specific one a domain declares for an aggregate.


## What EF Core already gives us
The Repository comes from Martin Fowler's *Patterns of Enterprise Application Architecture*: an object that "mediates between the domain and data mapping layers using a collection-like interface". Eric Evans added one constraint in *Domain-Driven Design*: one repository per aggregate root, never one per entity inside it.

EF Core's own documentation describes `DbContext` as "a combination of the Unit Of Work and Repository patterns". A `DbSet<Order>` is a collection-like object with `Add`, `Remove`, `FindAsync` and LINQ. The context tracks every change and writes them in one `SaveChangesAsync`. And providers already abstract the database. So "abstracting the database" cannot justify a repository on top of EF Core. If one is worth having, it is for another reason.


## The generic repository
The version most of us met first looks like this:

```csharp
public interface IRepository<T>
    where T : class
{
    Task<IReadOnlyCollection<T>> GetAllAsync(CancellationToken cancellationToken = default);
    Task<IReadOnlyCollection<T>> FindAsync(Expression<Func<T, bool>> predicate, CancellationToken cancellationToken = default);
    IQueryable<T> Query();
    Task AddAsync(T entity, CancellationToken cancellationToken = default);
    Task SaveChangesAsync(CancellationToken cancellationToken = default);
}
```

It is written once, and every entity gets it for free. It usually fails for reasons that show up later:

- **It is `DbSet<T>` with fewer features.** `Include`, `AsNoTracking` or `ExecuteUpdateAsync` get added one by one, until the interface is a worse copy of what it hides.
- **`IQueryable<T>` leaks the ORM.** A caller writing `Query().Where(...)` is writing an EF Core query, and the repository no longer decides what is loaded.
- **`FindAsync(predicate)` moves the query to the caller.** Every service composes its own filter, and the same rule is written three ways.
- **One repository per table ignores aggregates.** `IRepository<OrderLine>` lets a service change a line without going through the order and its invariants.
- **`SaveChangesAsync` on each repository splits the unit of work.** Two repositories saved separately are two transactions.

A generic base class can still share `AddAsync` between implementations, inside the database adapter. The trouble starts when that interface becomes the contract the domain depends on.


## A specific repository is a port
In a hexagonal architecture, a repository is a **driven port**: an interface the domain declares for what it needs, implemented by an adapter. In [Blouppy Starter](https://starter.blouppy.com/), the one for workspaces reads:

```csharp
public interface IWorkspacesRepository
{
    Task<SearchResult<Workspace>> TryGetAsync(WorkspaceId id, CancellationToken cancellationToken = default);
    Task<int> CountByOrganizationAsync(OrganizationId organizationId, CancellationToken cancellationToken = default);
    Task<Workspace> AddAsync(Workspace workspace, CancellationToken cancellationToken = default);
    Workspace Update(Workspace workspace);
    Task<int> TransferOwnershipAsync(OrganizationId organizationId, UserId fromOwnerId, UserId toOwnerId, CancellationToken cancellationToken = default);
    Task DeleteAsync(WorkspaceId id, CancellationToken cancellationToken = default);
}
```

Every method has a caller. `CountByOrganizationAsync` exists because the creation validator checks the plan's workspace limit. `TransferOwnershipAsync` exists because a departing member's workspaces go to someone else. There is no `GetAll`, no expression and no `IQueryable`: the arguments are domain types. A missing row is a `SearchResult`, not a null to forget. And nothing here saves: the controller commits once per request, through a separate `IUnitOfWork`.

The adapter is an `internal sealed` class over the `DbContext`, and the queries stay in it:

```csharp
public async Task<int> TransferOwnershipAsync(
    OrganizationId organizationId,
    UserId fromOwnerId,
    UserId toOwnerId,
    CancellationToken cancellationToken = default)
    => await dbContext.Workspaces
        .Where(x => x.OrganizationId == organizationId && x.OwnerId == fromOwnerId)
        .ExecuteUpdateAsync(
            setters => setters.SetProperty(x => x.OwnerId, toOwnerId),
            cancellationToken);
```

This is a single `UPDATE` that bypasses the change tracker. The interface's documentation says so, and that a second call changes nothing. A generic `IRepository<T>` has no place to say it.

The same rule applies to aggregates. A team owns its members, and changes them only through its own methods. So there is an `ITeamsRepository` that loads a team with its members, and no `ITeamMembersRepository`.

The domain project has no reference to EF Core at all. A service cannot write `Include` or `ExecuteUpdateAsync`, even by accident, and the [architecture tests](/blog/2026-07-03-architecture-tests-that-fail-the-build/) keep it that way. Reads take a separate path, with their own query ports that return projections for a screen, so the write repository never grows a method for a page.


## Testing: the right thing on the right side
Testability is often the first argument for a repository, and it is half true. Mocking `ITeamsRepository` is a good way to test the service's orchestration. It says nothing about whether a bulk delete removes the right rows: a nested `Any` and an `ExecuteDeleteAsync` only mean something on a real database. Mocking `DbSet<T>` is worse, because LINQ to objects does not behave like SQL.

So the repositories themselves are tested on PostgreSQL, started by Testcontainers, with the real migrations. The setup is in [testing EF Core repositories with Testcontainers](/blog/2026-07-15-testing-ef-core-repositories-with-testcontainers/).


## When DbContext directly is enough
A specific repository costs an interface, an implementation, a registration and integration tests per aggregate. A new query means editing three files instead of one. That cost is not always paid back.

In a small CRUD API, an endpoint loads a row, copies fields and saves. There is no domain to protect, and a `DbContext` injected into a thin service is simpler. In vertical slices, the query is the feature, and a shared repository adds distance. Reporting screens read and enforce nothing, so a projection over `DbContext` is the shortest path. And a repository that also exposes `IQueryable<T>` "just for this case" has all the costs and none of the benefits.

The repository earns its place when there is a domain model with invariants worth protecting, several domains on one database, or a rule that the domain must not see EF Core.


## References
- [Repository (Martin Fowler)](https://martinfowler.com/eaaCatalog/repository.html) — the original definition of the pattern.
- [Design the infrastructure persistence layer (Microsoft Learn)](https://learn.microsoft.com/dotnet/architecture/microservices/microservice-ddd-cqrs-patterns/infrastructure-persistence-layer-design) — repositories per aggregate with EF Core.
- [Choosing a testing strategy (Microsoft Learn)](https://learn.microsoft.com/ef/core/testing/choosing-a-testing-strategy) — real database, test doubles and the repository pattern.
- [Separating reads and writes in ASP.NET Core without MediatR](/blog/2026-06-21-separating-reads-and-writes-without-mediatr/) — the read side and its projections in detail.
