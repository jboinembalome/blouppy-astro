---
templateKey: 'blog-post'
title: 'Separating reads and writes in ASP.NET Core without MediatR'
date: 2026-06-21T09:00:00.000Z
author: Jimmy Boinembalome
authorimage: /img/jimmy.jpg
category: C#
categorycolor: bg-purple-100 text-purple-800
featuredpost: true
featuredimage: /img/separating-reads-and-writes-without-mediatr.jpg
description: >-
  Learn how to split an ASP.NET Core API into a read side and a write side with plain interfaces, projections and a result type, chosen by HTTP verb, with no mediator in between.
tags:
  - Development
  - C#
  - ASP.NET Core
  - EF Core
  - Architecture
---

Separating reads from writes, a "CQRS-lite", is usually explained with **MediatR**. But the idea itself does not need a library: a screen that lists members with their names and avatars has very little in common with a request that creates a workspace, and two plain sets of interfaces are enough to keep them apart.

In this article, we will build both sides in an **ASP.NET Core** API: a read side made of projections, query filters and pages, a write side made of domain services, **FluentValidation** and a `ValidationResult<T>`, and a controller that picks one or the other by HTTP verb.


## Two verticals above one domain
Here is the whole idea in one table:

| | Reads (`GET`) | Writes (`POST`/`PUT`/`DELETE`) |
| --- | --- | --- |
| Contract | `IXxxApiQueryService` | `IXxxService` |
| Data access | `IXxxApiQueryRepository` | `IXxxRepository` |
| Returns | Projections and pages | Domain entities in a `ValidationResult<T>` |

Both verticals sit on the same domain model, and nothing crosses diagonally: a read service never calls a write repository, a write service never calls a read repository, and the controller never injects a repository at all.

Why bother? Because much of what a screen shows has no identity, no behaviour and no invariant. A member listed with the name and e-mail joined from another table, a page of results: none of that is a domain entity, and forcing it into the model would fill the domain with shapes that only exist for display.

In the code base this comes from, the read side is three projects: `Blouppy.ApiQuery.Models` (projections, filters, paging), `Blouppy.ApiQuery.Abstractions` (the interfaces) and `Blouppy.ApiQuery` (their `internal sealed` implementations). The write side is one pair per domain, such as `Blouppy.Workspaces.Abstractions` and `Blouppy.Workspaces`.


## The read side

### A projection
Let's start with what a screen actually needs. Here is the projection the organization's member list reads:

```csharp
namespace Blouppy.ApiQuery.Models.Organizations.Members;

public record DetailedOrganizationMember
{
    public required OrganizationId OrganizationId { get; init; }
    public required UserId MemberId { get; init; }
    public required OrganizationRole Role { get; init; }
    public required string UserName { get; init; }
    public required string Email { get; init; }
    public required string? AvatarUrl { get; init; }
    public required bool IsDeactivated { get; init; }
}
```

It is a plain record with `required` properties, no constructor logic and no methods. The membership (`OrganizationId`, `MemberId`, `Role`) comes from one table, the name, e-mail and avatar from another. No entity has this shape, and none should.

### A query filter and a page
A list endpoint needs paging and sorting, so the filters inherit them from a small base record:

```csharp
public abstract record OffsetAndSortQuery : IOffsetQuery, ISortQuery
{
    public required int Page { get; init; }
    public required int PageSize { get; init; }
    public required IReadOnlyCollection<SortingKey> Sort { get; init; }
}

public sealed record OrganizationMemberQueryFilter : OffsetAndSortQuery
{
    public required OrganizationId OrganizationId { get; init; }
    public required string Search { get; init; }
}
```

And here is the page the query returns, from `Blouppy.ApiQuery.Models/Paging/OffsetPage.cs`:

```csharp
public class OffsetPage<T>
    where T : class
{
    public IEnumerable<T> Items { get; set; } = [];
    public int? NextPage { get; set; }
    public int? PreviousPage { get; set; }
    public int TotalCount { get; set; }
}
```

There are two page shapes, used by every list endpoint:
- `OffsetPage<T>` with `IOffsetQuery`: page numbers and a total, for tables.
- `CursorPage<T>` with `ICursorQuery`: an opaque `NextCursor` / `PreviousCursor`, for feeds and infinite lists.

> **_Note:_**  The page size is checked before the controller even runs: `OffsetQueryValidationFilter` (and its cursor twin) is a global `IActionFilter` that answers 400 for a `Page` below 1 or a `PageSize` above 1000.

### The repository: straight to SQL
Now the interesting part. The read repository is an EF Core query that selects exactly the columns of the projection, joined on `users_view`, the local projection of the people the identity host owns:

```csharp
internal sealed class OrganizationMembersApiQueryRepository(
    BlouppyDbContext dbContext) : IOrganizationMembersApiQueryRepository
{
    public async Task<OffsetPage<DetailedOrganizationMember>> GetAsync(
        OrganizationMemberQueryFilter filter,
        CancellationToken cancellationToken = default)
    {
        var query = from organizationMember in Query()
            join user in dbContext.UserViews
                on organizationMember.MemberId equals user.Id
            where organizationMember.OrganizationId == filter.OrganizationId
                  && (string.IsNullOrWhiteSpace(filter.Search)
                      || EF.Functions.ILike(user.UserName, $"%{filter.Search}%"))
            select new DetailedOrganizationMember
            {
                OrganizationId = organizationMember.OrganizationId,
                MemberId = organizationMember.MemberId,
                Role = organizationMember.Role,
                UserName = user.UserName,
                Email = user.Email,
                AvatarUrl = user.AvatarUrl,
                IsDeactivated = user.DeactivatedAt != null
            };

        return await query
            .ApplySort(filter)
            .ToOffsetPageAsync(filter, cancellationToken);
    }

    private IQueryable<OrganizationMember> Query()
        => dbContext.OrganizationMembers
            .AsNoTracking();
}
```

Let's look at what it does:
- `AsNoTracking()`: a read never changes anything, so the change tracker has nothing to do.
- The `join` and the `select new DetailedOrganizationMember` are translated to one SQL query: no entity is materialised, only the seven columns the screen needs.
- `EF.Functions.ILike` is PostgreSQL's case-insensitive `LIKE`, so the search runs in the database.
- `ToOffsetPageAsync`, an extension method of the database project, counts the rows, takes one page with `Skip`/`Take` and fills `NextPage` and `PreviousPage`.

The interface itself, `IOrganizationMembersApiQueryRepository`, lives in `Blouppy.Infrastructure.Database.Abstractions`, next to the write repositories. A feature's data access is described in one place; only what the read ports *return* lives elsewhere.

### The read service
The service on top is almost empty, and that is fine:

```csharp
internal sealed class OrganizationMembersApiQueryService(
    IOrganizationMembersApiQueryRepository organizationMembersApiQueryRepository,
    IOrganizationMembershipsApiQueryRepository organizationMembershipsApiQueryRepository) : IOrganizationMembersApiQueryService
{
    public Task<OffsetPage<DetailedOrganizationMember>> GetAsync(
        OrganizationMemberQueryFilter filter,
        CancellationToken cancellationToken = default)
        => organizationMembersApiQueryRepository.GetAsync(filter, cancellationToken);
}
```

Why keep a layer that only forwards? Because the controller never depends on a repository: the day a read combines two queries, the change stays inside `Blouppy.ApiQuery`. And there is **one read service per feature**: a view that needs its own shape gets a projection and a method here, not a second entry point.


## The write side
A write has rules to enforce, so it goes through the domain. Here is the contract the Web calls in through:

```csharp
namespace Blouppy.Workspaces.Abstractions;

public sealed record WorkspaceCreation(
    string Name,
    Colour Colour,
    UserId OwnerId,
    OrganizationId OrganizationId);

public interface IWorkspacesService
{
    Task<ValidationResult<Workspace>> TryAddAsync(WorkspaceCreation workspaceCreation, CancellationToken cancellationToken = default);
    Task<ValidationResult<Workspace>> TryUpdateAsync(WorkspaceEdition workspaceEdition, CancellationToken cancellationToken = default);
    Task<DeletionResult> TryDeleteAsync(WorkspaceId id, CancellationToken cancellationToken = default);
}
```

Nothing is thrown for a rule the user broke: the outcome is a value.

### ValidationResult<T>
Here is the result type, from `Blouppy.SharedKernel/Results/ValidationResult.cs` (trimmed):

```csharp
public class ValidationResult
{
    public bool Succeeded { get; }
    public bool Failed => !Succeeded;
    public IDictionary<string, string[]> Errors { get; }

    public static ValidationResult<T> Success<T>(T value)
        => new(value, true, new Dictionary<string, string[]>());

    public static ValidationResult<T> Failure<T>(IDictionary<string, string[]> errors)
        => new(default, false, errors);
}

public sealed class ValidationResult<T>(
    T? value,
    bool succeeded,
    IDictionary<string, string[]> errors)
    : ValidationResult(succeeded, errors)
{
    [NotNull]
    public T Value => Succeeded
        ? value!
        : throw new InvalidOperationException($"{nameof(Value)} cannot be accessed when validation has failed.");
}
```

- `Errors` is an `IDictionary<string, string[]>`, the exact shape `ValidationProblemDetails` takes, so a failure becomes a standard 400 response with no conversion.
- `Value` throws if we read it after a failure: a forgotten check fails at once instead of passing a `null` along.

### The validator
The validator is an ordinary FluentValidation `AbstractValidator<T>`. The interesting rule is the plan limit:

```csharp
internal sealed class WorkspaceCreationValidator : AbstractValidator<WorkspaceCreation>
{
    public WorkspaceCreationValidator(
        IOrganizationsPublicDataService organizationsPublicDataService,
        IWorkspacesRepository workspacesRepository)
    {
        RuleFor(p => p.Name)
            .NotEmpty()
            .MaximumLength(50);

        RuleFor(x => x.OrganizationId)
            .MustAsync(HaveRoomForAnotherWorkspaceAsync)
            .WithMessage("The organization has reached the number of workspaces its plan allows.");
    }

    // HaveRoomForAnotherWorkspaceAsync reads the plan's MaxWorkspaces, then
    // compares it with workspacesRepository.CountByOrganizationAsync(...).
}
```

Notice where the count comes from: `IWorkspacesRepository`, the **write** repository the validator already has. Validators belong to the write side, and the write side never reaches into a read port, even for a number that looks like "a read".

### The service
Here is the domain service, trimmed to the creation:

```csharp
internal sealed class WorkspacesService(
    IWorkspacesRepository workspacesRepository,
    IValidator<WorkspaceCreation> workspaceCreationValidator,
    IValidator<WorkspaceEdition> workspaceEditionValidator,
    ICurrentUserService currentUserService) : IWorkspacesService
{
    public async Task<ValidationResult<Workspace>> TryAddAsync(
        WorkspaceCreation workspaceCreation,
        CancellationToken cancellationToken = default)
    {
        workspaceCreation = workspaceCreation with
        {
            OwnerId = currentUserService.UserId
        };

        var result = await workspaceCreationValidator.ValidateAsync(workspaceCreation, cancellationToken);

        if (!result.IsValid)
        {
            return ValidationResult.Failure<Workspace>(result.ToDictionary());
        }

        var workspace = new Workspace(
            name: workspaceCreation.Name,
            colour: workspaceCreation.Colour,
            ownerId: workspaceCreation.OwnerId,
            organizationId: workspaceCreation.OrganizationId);

        await workspacesRepository.AddAsync(workspace, cancellationToken);

        workspace.MarkAsCreated();

        return ValidationResult.Success(workspace);
    }
}
```

- The owner is never trusted from the request: it is overwritten with the current user before validation.
- `result.ToDictionary()` is FluentValidation's own method, and it already returns the `IDictionary<string, string[]>` our result expects.
- `MarkAsCreated()` raises a domain event on the entity.
- And the service **does not commit**. It adds the entity to the repository and returns. Who commits, then? The controller.


## The controller picks a side by HTTP verb
`WorkspacesController` injects both contracts. Its GETs call the read side, its POST, PUT and DELETE the write side:

```csharp
public class WorkspacesController(
    IWorkspacesService workspacesService,
    IWorkspacesApiQueryService workspacesApiQueryService,
    IWorkspaceDtoFactory workspaceDtoFactory,
    IAuthorizationService authorizationService,
    IUnitOfWork unitOfWork) : ControllerBase
{
    [HttpGet(Name = RouteNames.Api.Workspaces.GetAll)]
    public async Task<ActionResult<IEnumerable<WorkspaceDto>>> GetAllAsync(
        [FromQuery] WorkspaceQueryFilterDto filterDto,
        CancellationToken cancellationToken)
    {
        var filter = WorkspaceMapper.MapToQueryFilter(filterDto);

        var workspaces = await workspacesApiQueryService.GetAsync(filter, cancellationToken);

        var dtos = await workspaceDtoFactory.CreateAsync(workspaces, cancellationToken);

        return Ok(dtos);
    }

    [HttpPost(Name = RouteNames.Api.Workspaces.Create)]
    public async Task<ActionResult<WorkspaceDto>> CreateAsync(
        WorkspaceCreationDto workspaceCreationDto,
        CancellationToken cancellationToken)
    {
        if (!await authorizationService.IsAuthorizedAsync(User, new OrganizationId(workspaceCreationDto.OrganizationId), Policies.Manage))
        {
            return Forbid();
        }

        var workspaceCreation = WorkspaceMapper.MapToCreation(workspaceCreationDto);

        var result = await workspacesService.TryAddAsync(workspaceCreation, cancellationToken);

        return await result.MatchAsync(
            onSuccess: async workspace =>
            {
                await unitOfWork.CommitAsync(cancellationToken);

                var dto = await workspaceDtoFactory.CreateAsync(workspace, cancellationToken);

                return CreatedAtRoute(RouteNames.Api.Workspaces.Get, new { id = dto.Id }, dto);
            },
            onFailed: BadRequest);
    }
}
```

The controller does four small things, in this order: it checks the caller's right, maps a DTO to an input record, calls **one** port, and maps the result to a status code. `IUnitOfWork.CommitAsync` is called only on success, so nothing reaches the database for a refused request: one request, one commit.

`MatchAsync` is a tiny extension method in the Web project:

```csharp
internal static class ValidationResultExtensions
{
    public static async Task<ActionResult> MatchAsync<T>(
        this ValidationResult<T> validationResult,
        Func<T, Task<ActionResult>> onSuccess,
        Func<ValidationProblemDetails, ActionResult> onFailed)
        where T : class
        => validationResult.Succeeded
            ? await onSuccess(validationResult.Value)
            : onFailed(GetValidationProblemDetails(validationResult));
}
```

`GetValidationProblemDetails` builds a 400 `ValidationProblemDetails` from `Errors`, which `onFailed: BadRequest` hands to `ControllerBase.BadRequest`. The same pattern exists for `SearchResult<T>` and `DeletionResult`.

> **_Note:_**  This is the whole "dispatch": a constructor parameter and a method call. "Go to definition" on `TryAddAsync` lands on the interface, and "Go to implementation" on `WorkspacesService`. 😉


## Keeping the two sides apart
A split like this erodes quietly: one day a validator injects a read repository "just for a count". So the rules are tests. `ReadSideBoundaryTests` (built on NetArchTest) checks that only `Blouppy.ApiQuery` depends on an `IXxxApiQueryRepository`, that `Blouppy.ApiQuery.Models` stays a leaf depending on the domain models only, that the read contracts do not depend on the write side, and that the read services stay `internal`.

The leaf rule is what makes the rest possible: because `Blouppy.ApiQuery.Models` depends on the domain models only, the database ports can return `DetailedOrganizationMember` or `OffsetPage<T>` without referencing the read layer. For the same reason, `SearchResult<T>`, which the write repositories use too, lives in `Blouppy.SharedKernel`.

What it costs:
- **More types.** A list gets a projection, a filter, a service and a repository interface: the price of each screen getting exactly its shape.
- **The queries are not in the read project.** The EF Core implementations stay in `Blouppy.Infrastructure.Database`, because they need `BlouppyDbContext`. Moving them was deliberately not done: it would mean exposing or moving the context.


## Conclusion
Separating reads and writes does not need a mediator. Two sets of plain interfaces are enough: `IXxxApiQueryService` returns projections and pages straight from SQL, `IXxxService` validates with FluentValidation and returns a `ValidationResult<T>`, and the controller picks one by HTTP verb, then commits only on success.

Everything stays navigable in the IDE, with plain constructor injection, and a handful of architecture tests keep the two sides from leaking into each other.

This is how reads and writes are separated in [Blouppy Starter](https://starter.blouppy.com/), across every domain and module of its ASP.NET Core API. The [reads and writes page](https://docs.starter.blouppy.com/architecture/reads-and-writes/) of its documentation sums up the rules.

*Thanks for reading! 🙂*
