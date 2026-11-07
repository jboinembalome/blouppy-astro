---
templateKey: 'blog-post'
title: 'Separating reads and writes in ASP.NET Core without MediatR'
date: 2026-06-21T09:00:00.000Z
updated: 2026-11-07T09:00:00.000Z
author: Jimmy Boinembalome
authorimage: /img/jimmy.jpg
category: C#
topic: 'Architecture'
illustration: 1
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

Separating reads from writes, a "CQRS-lite", is usually explained with **MediatR**. The idea needs no library: a screen that lists members with their names and avatars has little in common with a request that creates a workspace, and two plain sets of interfaces are enough to keep them apart.

In this article, we will build both sides of an **ASP.NET Core** API: a read side of projections and pages, a write side of domain services, **FluentValidation** and a `ValidationResult<T>`, and a controller that picks one by HTTP verb.


## Two verticals above one domain
Here is the whole idea in one table:

| | Reads (`GET`) | Writes (`POST`/`PUT`/`DELETE`) |
| --- | --- | --- |
| Contract | `IXxxApiQueryService` | `IXxxService` |
| Data access | `IXxxApiQueryRepository` | `IXxxRepository` |
| Returns | Projections and pages | Domain entities in a `ValidationResult<T>` |

Both verticals sit on the same domain model, and nothing crosses diagonally: a read service never calls a write repository, a write service never calls a read repository, and the controller never injects a repository at all. It is the core of the [CQRS pattern](https://learn.microsoft.com/azure/architecture/patterns/cqrs), without separate stores or a bus.

Why bother? Much of what a screen shows has no identity, no behaviour and no invariant, and forcing it into the model fills the domain with shapes that exist only for display.

In [Blouppy Starter](https://docs.starter.blouppy.com/architecture/reads-and-writes/), the read side is three projects: `Blouppy.ApiQuery.Models` (projections, filters, paging), `Blouppy.ApiQuery.Abstractions` (interfaces) and `Blouppy.ApiQuery` (implementations). The write side is one pair per domain, such as `Blouppy.Workspaces.Abstractions` and `Blouppy.Workspaces`.


## The read side

### A projection
Here is what the organization's member list reads:

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

The membership comes from one table, the name, e-mail and avatar from another. No entity has this shape, and none should.

Its filter, `OrganizationMemberQueryFilter`, adds `OrganizationId` and `Search` to a base record, `OffsetAndSortQuery`, that carries `Page`, `PageSize` and `Sort`. Every list returns one of two page shapes: `OffsetPage<T>` (items, previous and next page, total count) for tables, or `CursorPage<T>` (opaque cursors) for feeds.

> **_Note:_**  The page size is checked before the controller runs: `OffsetQueryValidationFilter` (and its cursor twin) is a global action filter that answers 400 for a `Page` below 1 or a `PageSize` outside 1 to 1000.

### The repository: straight to SQL
The read repository selects exactly the columns of the projection, joined on `users_view`, the local projection of the people the identity host owns:

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

- [`AsNoTracking()`](https://learn.microsoft.com/ef/core/querying/tracking): a read changes nothing, so the change tracker has nothing to do.
- The `join` and the `select new` translate to one SQL query that returns seven columns; no entity is materialized.
- [`EF.Functions.ILike`](https://www.npgsql.org/efcore/mapping/translations.html) is PostgreSQL's case-insensitive `LIKE`, so the search runs in the database.
- `ToOffsetPageAsync` counts the rows, takes one page with `Skip`/`Take` and fills the page numbers.

The read service on top, `OrganizationMembersApiQueryService`, only forwards to the repository. It still earns its place: the controller never depends on a repository, so the day a read combines two queries, the change stays inside `Blouppy.ApiQuery`.


## The write side
A write has rules to enforce, so it goes through the domain. Here is the contract the Web calls:

```csharp
public interface IWorkspacesService
{
    Task<ValidationResult<Workspace>> TryAddAsync(WorkspaceCreation workspaceCreation, CancellationToken cancellationToken = default);
    Task<ValidationResult<Workspace>> TryUpdateAsync(WorkspaceEdition workspaceEdition, CancellationToken cancellationToken = default);
    Task<DeletionResult> TryDeleteAsync(WorkspaceId id, CancellationToken cancellationToken = default);
}
```

`WorkspaceCreation` is a positional record (`Name`, `Colour`, `OwnerId`, `OrganizationId`). Nothing is thrown for a rule the user broke: the outcome is a value.

### The `ValidationResult<T>` type
Here is the result type, from `Blouppy.SharedKernel/Results/ValidationResult.cs` (trimmed to the generic case):

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

`Errors` has the shape [`ValidationProblemDetails`](https://learn.microsoft.com/dotnet/api/microsoft.aspnetcore.mvc.validationproblemdetails) takes, so a failure becomes a standard 400 with no conversion. `Value` throws when read after a failure, so a forgotten check fails at once.

### The validator
`WorkspaceCreationValidator` is an ordinary [FluentValidation](https://docs.fluentvalidation.net/en/latest/) `AbstractValidator<WorkspaceCreation>`: `Name` is not empty and at most 50 characters, `Colour` is in the enum. The interesting rule is the plan limit, an [asynchronous rule](https://docs.fluentvalidation.net/en/latest/async.html):

```csharp
RuleFor(x => x.OrganizationId)
    .MustAsync(HaveRoomForAnotherWorkspaceAsync)
    .WithMessage("The organization has reached the number of workspaces its plan allows.");
```

`HaveRoomForAnotherWorkspaceAsync` reads the plan's `MaxWorkspaces` through the Organizations domain's public contract, then compares it with `IWorkspacesRepository.CountByOrganizationAsync`. The count comes from the **write** repository: validators belong to the write side, which never reaches into a read port, even for a number that looks like "a read".

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

The owner is never trusted from the request: it is overwritten with the current user before validation. FluentValidation's `ToDictionary()` already returns the dictionary the result expects. And the service **does not commit**: the controller does.


## The controller picks a side by HTTP verb
`WorkspacesController` injects both contracts: its `GET` actions call `IWorkspacesApiQueryService`, its `POST`, `PUT` and `DELETE` actions call `IWorkspacesService`. Here is the creation:

```csharp
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
```

The action checks the caller's right with [resource-based authorization](https://learn.microsoft.com/aspnet/core/security/authorization/resourcebased), maps a DTO to an input record, calls **one** port and maps the result to a status code. `IUnitOfWork.CommitAsync` runs only on success, so a refused request writes nothing: one request, one commit.

`MatchAsync` is a small extension method in the Web project:

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

`GetValidationProblemDetails` builds a 400 [problem details](https://learn.microsoft.com/aspnet/core/web-api/handle-errors) body from `Errors`. The same pattern exists for `SearchResult<T>` and `DeletionResult`.

That is the whole "dispatch": a constructor parameter and a method call, which "Go to implementation" follows.


## Keeping the two sides apart
A split like this erodes quietly: one day a validator injects a read repository "just for a count". So the rules are tests. `ReadSideBoundaryTests`, built on [NetArchTest](https://www.nuget.org/packages/NetArchTest.Rules), checks that only `Blouppy.ApiQuery` depends on an `IXxxApiQueryRepository`, that `Blouppy.ApiQuery.Models` depends on the domain models only, that the read contracts do not depend on the write side, and that the read services stay `internal`.

That leaf rule is what lets the database ports return `DetailedOrganizationMember` without referencing the read layer. The cost is more types (a projection, a filter, a service and a repository interface per list), and queries that live in `Blouppy.Infrastructure.Database`, next to `BlouppyDbContext`, rather than in the read project.


## Conclusion
Separating reads and writes does not need a mediator. `IXxxApiQueryService` returns projections straight from SQL, `IXxxService` validates and returns a `ValidationResult<T>`, and the controller picks one by HTTP verb and commits only on success. A few architecture tests keep the two sides apart.

This is how reads and writes are separated across every domain and module of [Blouppy Starter](https://starter.blouppy.com/).


## References
- [CQRS pattern](https://learn.microsoft.com/azure/architecture/patterns/cqrs) (Azure Architecture Center) — the pattern and when to use it.
- [Tracking vs. no-tracking queries](https://learn.microsoft.com/ef/core/querying/tracking) (Microsoft Learn) — `AsNoTracking` and untracked projections.
- [Translations](https://www.npgsql.org/efcore/mapping/translations.html) (Npgsql EF Core provider) — `EF.Functions.ILike` and other PostgreSQL functions.
- [Resource-based authorization](https://learn.microsoft.com/aspnet/core/security/authorization/resourcebased) (Microsoft Learn) — imperative checks with `IAuthorizationService`.
- [Handle errors in ASP.NET Core APIs](https://learn.microsoft.com/aspnet/core/web-api/handle-errors) (Microsoft Learn) — problem details and `ValidationProblemDetails`.
- [FluentValidation](https://docs.fluentvalidation.net/en/latest/) and [Asynchronous validation](https://docs.fluentvalidation.net/en/latest/async.html) — validators and `MustAsync`.
- [NetArchTest.Rules](https://www.nuget.org/packages/NetArchTest.Rules) (NuGet) — the library behind the boundary tests.
- [Reads and writes](https://docs.starter.blouppy.com/architecture/reads-and-writes/) (Blouppy Starter docs) — the rules of the two verticals.
