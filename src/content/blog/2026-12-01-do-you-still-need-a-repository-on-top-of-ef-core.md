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

Every few months, the same discussion comes back: "EF Core already is a repository, so wrapping it in another one is pointless." The other camp answers that a domain should never see `DbContext`. Both are right about something, and most of the disagreement comes from talking about two different repositories: the generic one that wraps a table, and the specific one that a domain declares for an aggregate.

In this article, we will go back to the original definition of the pattern, see what `DbContext` and `DbSet<T>` already provide, look fairly at the generic repository, then at specific repositories in a real hexagonal code base, [Blouppy Starter](https://starter.blouppy.com/). We will finish with the cases where using `DbContext` directly is the better choice.


## The pattern
The Repository is not a Gang of Four pattern. It comes from Martin Fowler's *Patterns of Enterprise Application Architecture* and was refined by Eric Evans in *Domain-Driven Design*.

Fowler defines it as an object that "mediates between the domain and data mapping layers using a collection-like interface for accessing domain objects". Evans adds two constraints:

- **One repository per aggregate root.** A repository gives access to a whole aggregate, never to an entity inside one. An order's lines are reached through the order.
- **The illusion of an in-memory collection.** The domain adds, finds and removes objects; how they reach the database is someone else's concern.

Here is the shape in its smallest form:

```csharp
public interface IOrdersRepository
{
    Task<Order?> TryGetAsync(OrderId id, CancellationToken cancellationToken = default);
    Task<IReadOnlyCollection<Order>> GetUnpaidOlderThanAsync(DateTimeOffset date, CancellationToken cancellationToken = default);
    Task AddAsync(Order order, CancellationToken cancellationToken = default);
}
```

The interface speaks the domain's language: an order, its id, "unpaid older than". Nothing in it says SQL, table or query.


## What EF Core already gives us
EF Core's own API documentation describes `DbContext` as "a combination of the Unit Of Work and Repository patterns". That is accurate:

- A `DbSet<Order>` is a collection-like object: `Add`, `Remove`, `FindAsync`, and LINQ to query it.
- The `DbContext` tracks every change and writes them all in one `SaveChangesAsync`, which is a unit of work.
- Providers are already an abstraction: the same code runs on PostgreSQL, SQL Server or SQLite.

So a repository on top of EF Core cannot be justified by "abstracting the database". EF Core already does that. If a repository is worth having, it is for another reason.


## The generic repository
The generic repository is the version most of us met first. It usually looks like this:

```csharp
public interface IRepository<T>
    where T : class
{
    Task<IReadOnlyCollection<T>> GetAllAsync(CancellationToken cancellationToken = default);
    Task<IReadOnlyCollection<T>> FindAsync(Expression<Func<T, bool>> predicate, CancellationToken cancellationToken = default);
    IQueryable<T> Query();
    Task AddAsync(T entity, CancellationToken cancellationToken = default);
    void Remove(T entity);
    Task SaveChangesAsync(CancellationToken cancellationToken = default);
}
```

It is popular for good reasons. It is written once and every entity gets it for free. It gives the team one consistent way to load and save. And it promises that the ORM can be swapped one day.

It usually fails for reasons that only show up later:

- **It is `DbSet<T>` with fewer features.** `Include`, `AsNoTracking`, `ExecuteUpdateAsync` or a projection with `Select` are either missing or added one by one, until the interface is a worse copy of the one it hides.
- **`IQueryable<T>` leaks the ORM.** A caller writing `Query().Where(...)` is writing an EF Core query. Whether it translates to SQL is only known at run time, and the repository has stopped deciding what is loaded.
- **`FindAsync(predicate)` moves the query to the caller.** The repository no longer says what the domain needs; every service composes its own filter, and the same rule is written three different ways.
- **`GetAllAsync` loads a table.** On a small table, nobody notices. On a large one, it is the slowest endpoint of the application.
- **One repository per table ignores aggregates.** `IRepository<OrderLine>` lets a service change a line without going through the order and its invariants.
- **`SaveChangesAsync` on each repository splits the unit of work.** Two repositories saved separately are two transactions.
- **The ORM is rarely swapped.** The leaks above make the swap impossible anyway.

A generic base class can still be useful inside the database adapter, to share `AddAsync` and `Update` between implementations. The problem starts when that generic interface becomes the contract the domain depends on.


## A specific repository: a port the domain owns
In a hexagonal architecture, a repository is a **driven port**: an interface the domain declares for what it needs, implemented by an adapter. In Blouppy Starter, the ports live in `Blouppy.Infrastructure.Database.Abstractions`, which references the domain models and nothing else. Here is the one for workspaces:

```csharp
namespace Blouppy.Infrastructure.Database.Abstractions.Workspaces;

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

- **Every method has a caller.** `CountByOrganizationAsync` exists because the creation validator checks the plan's workspace limit. `TransferOwnershipAsync` exists because a deprovisioned member's workspaces go to someone else. There is no `GetAll`.
- **The arguments are domain types.** Strongly-typed ids and the `Workspace` aggregate; no expression, no `IQueryable`.
- **A missing row is a value.** `TryGetAsync` returns a `SearchResult<Workspace>` rather than a null to forget.
- **It does not save.** `AddAsync` and `Update` only register the change. The controller commits through a separate port, `IUnitOfWork.CommitAsync`, once per request.

The adapter is an `internal sealed` class over `BlouppyDbContext`, in `Blouppy.Infrastructure.Database` (trimmed):

```csharp
internal sealed class WorkspacesRepository(
    BlouppyDbContext dbContext) : IWorkspacesRepository
{
    public async Task<int> CountByOrganizationAsync(
        OrganizationId organizationId,
        CancellationToken cancellationToken = default)
        => await dbContext.Workspaces
            .CountAsync(x => x.OrganizationId == organizationId, cancellationToken);

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
}
```

`TransferOwnershipAsync` is a single `UPDATE` that bypasses the change tracker. The interface documents it: the change happens at once rather than through the unit of work, and a second call changes nothing. A generic `IRepository<T>` has no place to say that.

### One aggregate, loaded whole
A team owns its members: `Team` holds a private list of `TeamMember` and changes it only through its methods, such as `Update` and `LinkToDirectoryGroup`; `Update` refuses to change the members of a team linked to a directory group. So there is an `ITeamsRepository` and no `ITeamMembersRepository`, and the repository loads the aggregate with its members:

```csharp
internal sealed class TeamsRepository(
    BlouppyDbContext dbContext) : ITeamsRepository
{
    public async Task<SearchResult<Team>> TryGetAsync(
        TeamId id,
        CancellationToken cancellationToken = default)
    {
        var team = await dbContext.Teams.FindAsync([id], cancellationToken);

        if (team is null)
        {
            return SearchResult.NotFound<Team>();
        }

        await dbContext.Entry(team)
            .Collection(x => x.Members)
            .LoadAsync(cancellationToken);

        return SearchResult.Create(team);
    }

    public async Task<int> RemoveMemberAsync(
        OrganizationId organizationId,
        UserId memberId,
        CancellationToken cancellationToken = default)
        => await dbContext.Set<TeamMember>()
            .Where(x => x.MemberId == memberId)
            .Where(x => dbContext.Teams
                .Where(team => team.Id == x.TeamId)
                .Any(team => dbContext.Workspaces
                    .Any(workspace => workspace.Id == team.WorkspaceId && workspace.OrganizationId == organizationId)))
            .ExecuteDeleteAsync(cancellationToken);
}
```

`TeamMember` is touched directly in exactly one place: `RemoveMemberAsync`, a bulk delete run when someone leaves an organization. That query knows about teams, workspaces and organizations, and it stays inside the adapter. The handler that calls it reads like the rule it implements:

```csharp
var removed = await teamsRepository.RemoveMemberAsync(@event.OrganizationId, @event.MemberId, cancellationToken);
```

### EF Core stays out of the domain
`Blouppy.Workspaces`, the project with the services, validators and handlers, references FluentValidation, its own contracts, the Organizations domain's public contract and two ports: `Blouppy.Infrastructure.Database.Abstractions` and `Blouppy.Infrastructure.Messaging.Abstractions`. It has no reference to EF Core, so a service cannot write `Include` or `ExecuteUpdateAsync` even by accident. The [architecture tests](/blog/2026-07-03-architecture-tests-that-fail-the-build/) hold that boundary.

That boundary also makes the services easy to unit test. `TeamsServiceTests` builds a `TeamsService` with `Mock.Of<ITeamsRepository>()` and checks the orchestration: validation first, then the aggregate's method, then `Update`.


## The read side bypasses the write repository
A screen does not need an aggregate it will change. Blouppy Starter gives reads their own ports, named `IXxxApiQueryRepository`, next to the write ones:

```csharp
public interface ITeamsApiQueryRepository
{
    Task<SearchResult<Team>> TryGetAsync(WorkspaceId workspaceId, CancellationToken cancellationToken = default);
}
```

Its adapter reads with `AsNoTracking()` and `Include(x => x.Members)`; others return projections shaped for one screen, such as `DetailedOrganizationMember`, straight from a `select new`. The write repository never grows a method for a page, and the read repository never registers a change.

The two must not mix, so `ReadSideBoundaryTests` checks it on every build (trimmed):

```csharp
var result = Types.InAssemblies([WebAssembly, .. DomainAssemblies])
    .That()
    .AreNotNested()
    .ShouldNot()
    .HaveDependencyOnAny(portNames)
    .GetResult();
```

`portNames` is every interface ending in `ApiQueryRepository` in the ports project. Neither the Web nor any domain may depend on one: only `Blouppy.ApiQuery` injects them. The full split, with its projections and pages, is in [Separating reads and writes in ASP.NET Core without MediatR](/blog/2026-06-21-separating-reads-and-writes-without-mediatr/).


## When DbContext directly is enough
A specific repository costs something. Each aggregate gets an interface, an implementation, a registration and integration tests. A new query means editing three files instead of one. And some readers will find "go to implementation" twice before reaching the SQL.

That cost is not always paid back:

- **A small application or a CRUD API.** If an endpoint loads a row, copies fields and saves, there is no domain to protect. A `DbContext` injected into the endpoint or a thin service is simpler, and EF Core already gives us the unit of work.
- **Vertical slices.** When each feature owns its handler, its query and its tests in one folder, the query is the feature. Moving it into a shared repository adds distance and no clarity.
- **Reporting and admin screens.** They read, they never enforce an invariant, and a projection over `DbContext` is the shortest path.
- **A team that will not keep the boundary.** A repository that also exposes `IQueryable<T>` "just for this case" has all the costs and none of the benefits.

The repository earns its place when there is a domain model with invariants worth protecting, several domains sharing one database, or a rule that EF Core must not be visible to the domain.

### Testing: mock the service's ports, not the database
Testability is often the first argument for a repository, and it is half true. Mocking `ITeamsRepository` is a good way to test `TeamsService`. It says nothing about whether `RemoveMemberAsync` deletes the right rows: the nested `Any` and the `ExecuteDeleteAsync` only mean something on a real database. Mocking `DbSet<T>` to test a service that uses `DbContext` directly is worse, because LINQ to objects does not behave like SQL.

So the repositories themselves are tested on PostgreSQL started by Testcontainers, with the real migrations. Their `TeamsRepositoryTests` checks that `RemoveMemberAsync` removes the member from every team of the organization, leaves other organizations alone, and removes nothing on a second call. The setup is in [Testing EF Core repositories on a real PostgreSQL with Testcontainers](/blog/2026-07-15-testing-ef-core-repositories-with-testcontainers/). Without a repository, the same approach works: test the service or the endpoint against a real database, and skip the mocks.


## Conclusion
`DbContext` already is a unit of work and `DbSet<T>` already is a collection-like repository, so a generic `IRepository<T>` on top mostly removes features and leaks `IQueryable<T>`. A specific repository is a different thing: a port the domain declares, one per aggregate, whose methods are named after what the domain needs and whose queries stay in the adapter. Pair it with a separate unit of work, give reads their own ports, and test the adapter on a real database. For a small CRUD application or a vertical slice, `DbContext` on its own is enough.

`IWorkspacesRepository`, `ITeamsRepository`, their adapters and `ReadSideBoundaryTests` are in [Blouppy Starter](https://starter.blouppy.com/).


## References
- [Repository (Martin Fowler, P of EAA Catalog)](https://martinfowler.com/eaaCatalog/repository.html) — the original definition of the pattern.
- [Domain-Driven Design Reference (Eric Evans)](https://www.domainlanguage.com/ddd/reference/) — aggregates and repositories, in Evans's own summary.
- [DbContext class (Microsoft Learn)](https://learn.microsoft.com/dotnet/api/microsoft.entityframeworkcore.dbcontext) — the API documentation that calls it a unit of work and a repository.
- [Design the infrastructure persistence layer (Microsoft Learn)](https://learn.microsoft.com/dotnet/architecture/microservices/microservice-ddd-cqrs-patterns/infrastructure-persistence-layer-design) — repositories per aggregate with EF Core, from the .NET microservices guide.
- [Choosing a testing strategy (Microsoft Learn)](https://learn.microsoft.com/ef/core/testing/choosing-a-testing-strategy) — real database, test doubles and the repository pattern for EF Core tests.
- [ExecuteUpdate and ExecuteDelete (Microsoft Learn)](https://learn.microsoft.com/ef/core/saving/execute-insert-update-delete) — bulk operations that bypass the change tracker.
- [Separating reads and writes in ASP.NET Core without MediatR](/blog/2026-06-21-separating-reads-and-writes-without-mediatr/) — the read side and its projections in detail.
- [Testing EF Core repositories on a real PostgreSQL with Testcontainers](/blog/2026-07-15-testing-ef-core-repositories-with-testcontainers/) — the integration tests behind the repositories.
