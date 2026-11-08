---
templateKey: 'blog-post'
title: 'Policy-based authorization in ASP.NET Core: requirements, handlers and resource checks'
date: 2026-06-18T09:00:00.000Z
author: Jimmy Boinembalome
authorimage: /img/jimmy.jpg
category: C#
topic: 'Security'
illustration: 2
categorycolor: bg-purple-100 text-purple-800
featuredpost: true
description: >-
  Learn how to write authorization policies in ASP.NET Core with requirements, handlers and resource checks, answer 403 without revealing what exists, and test the handlers.
tags:
  - Development
  - C#
  - ASP.NET Core
  - Security
---

Most APIs start with `[Authorize]` on every controller and a role check here and there: `[Authorize(Roles = "Admin")]`. That holds until the question becomes *"may this person edit **this** workspace?"*. A role is a property of the user; the answer now depends on the user **and** the data. So the check moves into the action, as an `if` that reads the database, and every controller grows its own slightly different copy of it.

In this article, we will replace those copies with ASP.NET Core's policy-based authorization: requirements, handlers, resource-based checks through `IAuthorizationService`, the choice between `403` and `404`, scopes for tokens, the default and fallback policies, and unit tests for the handlers. The real examples come from [Blouppy Starter](https://starter.blouppy.com/).


## Authentication is not authorization
**Authentication** answers *"who is calling?"*. A cookie or a bearer token is validated, and the result is a `ClaimsPrincipal`, `HttpContext.User`. **Authorization** answers *"may this caller do this?"*, from that principal and, often, from the resource. Keeping them apart is what lets a single policy work the same way behind a session cookie and behind a JWT. How the token reaches the API in the first place is the subject of [the BFF article](/blog/2026-05-10-keep-the-access-token-out-of-the-browser-bff-angular-yarp/); here, the user is already authenticated.


## Roles versus policies
A role is a claim, and `[Authorize(Roles = "Admin")]` is a shortcut for one specific check. A **policy** is a named list of **requirements**, all of which must succeed:

```csharp
builder.Services.AddAuthorization(options =>
{
    options.AddPolicy("Editors", policy =>
        policy
            .RequireAuthenticatedUser()
            .RequireClaim("scope", "documents.write")
            .RequireRole("Editor"));
});
```

`RequireClaim(type, values)` succeeds when the user has a claim of that type with **any** of the values. `RequireRole`, `RequireClaim` and `RequireAuthenticatedUser` are built-in requirements with built-in handlers. When the rule needs more than claims, we write our own.


## Requirements and handlers
A requirement is data; a handler is the code that decides. The requirement implements the marker interface `IAuthorizationRequirement`:

```csharp
public sealed class MinimumAgeRequirement(int minimumAge) : IAuthorizationRequirement
{
    public int MinimumAge { get; } = minimumAge;
}
```

The handler derives from `AuthorizationHandler<TRequirement>` and calls `context.Succeed(requirement)` when the rule holds:

```csharp
internal sealed class MinimumAgeHandler(TimeProvider timeProvider)
    : AuthorizationHandler<MinimumAgeRequirement>
{
    protected override Task HandleRequirementAsync(
        AuthorizationHandlerContext context,
        MinimumAgeRequirement requirement)
    {
        var birthDate = context.User.FindFirstValue(ClaimTypes.DateOfBirth);

        if (DateOnly.TryParse(birthDate, out var date)
            && date.AddYears(requirement.MinimumAge) <= DateOnly.FromDateTime(timeProvider.GetUtcNow().UtcDateTime))
        {
            context.Succeed(requirement);
        }

        return Task.CompletedTask;
    }
}
```

The semantics are the part to remember:

- Inside a policy, requirements combine with **AND**: every one must be met.
- For one requirement, handlers combine with **OR**: one `Succeed` is enough.
- Doing nothing means *"I cannot say yes"*. `context.Fail()` means *"no, whatever the others say"*, and is rarely what we want.

Handlers are registered as `IAuthorizationHandler` in the container, and they may take dependencies like any service.


## Resource-based checks
`[Authorize(Policy = "...")]` runs before the action, so the attribute never sees the resource. For a rule that depends on the data, we use `AuthorizationHandler<TRequirement, TResource>` and call `IAuthorizationService` from the action:

```csharp
internal sealed class DocumentAuthorHandler
    : AuthorizationHandler<SameAuthorRequirement, Document>
{
    protected override Task HandleRequirementAsync(
        AuthorizationHandlerContext context,
        SameAuthorRequirement requirement,
        Document resource)
    {
        if (resource.AuthorId == context.User.FindFirstValue(ClaimTypes.NameIdentifier))
        {
            context.Succeed(requirement);
        }

        return Task.CompletedTask;
    }
}

// In the action
var result = await authorizationService.AuthorizeAsync(User, document, "EditDocument");
```

The handler only runs when `context.Resource` is a `Document`. Passing a loaded entity is the textbook form, but it means reading the entity before we know whether the caller may see it. Passing an **identifier** as the resource, and letting the handler look up what it needs, avoids that and keeps the controller thin.


## The real example: one membership read
In Blouppy Starter, every organization-scoped rule is the same question: *"what is this user's role in the organization this resource belongs to?"*. Organizations rank their members `Viewer`, `Member` and `Admin`, and the owner passes every check. The requirement carries the minimum role:

```csharp
public sealed class MinimumRoleRequirement(
    OrganizationRole minimumRole) : IAuthorizationRequirement
{
    public OrganizationRole MinimumRole { get; } = minimumRole;
}
```

The three resource-based policies differ only by that role and by the scope they accept:

```csharp
options.AddPolicy(Policies.Read, policy =>
    policy
        .RequireAuthenticatedUser()
        .RequireClaim(BlouppyClaimTypes.Scope, ApiScopes.Reading)
        .AddRequirements(new MinimumRoleRequirement(OrganizationRole.Viewer)));

options.AddPolicy(Policies.Contribute, policy =>
    policy
        .RequireAuthenticatedUser()
        .RequireClaim(BlouppyClaimTypes.Scope, ApiScopes.Writing)
        .AddRequirements(new MinimumRoleRequirement(OrganizationRole.Member)));

options.AddPolicy(Policies.Manage, policy =>
    policy
        .RequireAuthenticatedUser()
        .RequireClaim(BlouppyClaimTypes.Scope, ApiScopes.Browser)
        .AddRequirements(new MinimumRoleRequirement(OrganizationRole.Admin)));
```

The policy names are constants in a `Policies` class, so a typo is a compile error instead of an exception at the first request.

The resource is a [strongly typed id](/blog/2026-05-16-strongly-typed-ids-with-ef-core/), an `OrganizationId` or a `WorkspaceId`. One generic base class does the work, and each concrete handler only says how to find the membership from its resource. Here it is, trimmed to the role check:

```csharp
internal abstract class MembershipAuthorizationHandlerBase<TResource> : IAuthorizationHandler
    where TResource : notnull
{
    protected abstract Task<SearchResult<OrganizationMembership>> TryGetMembershipAsync(
        UserId userId,
        TResource resource,
        CancellationToken cancellationToken);

    public async Task HandleAsync(AuthorizationHandlerContext context)
    {
        if (context.Resource is not TResource resource)
        {
            return;
        }

        var requirements = context.PendingRequirements.OfType<MinimumRoleRequirement>().ToList();

        if (requirements.Count == 0)
        {
            return;
        }

        var subject = context.User.FindFirstValue(BlouppyClaimTypes.Subject);

        if (string.IsNullOrEmpty(subject))
        {
            return;
        }

        var membership = await TryGetMembershipAsync(new UserId(subject), resource, CancellationToken.None);

        if (!membership.Found)
        {
            return;
        }

        foreach (var requirement in requirements.Where(x => membership.Value.HasMinimumRole(x.MinimumRole)))
        {
            context.Succeed(requirement);
        }
    }
}

internal sealed class WorkspaceAuthorizationHandler(
    IOrganizationMembershipsApiQueryService organizationMembershipsApiQueryService)
    : MembershipAuthorizationHandlerBase<WorkspaceId>
{
    protected override Task<SearchResult<OrganizationMembership>> TryGetMembershipAsync(
        UserId userId,
        WorkspaceId resource,
        CancellationToken cancellationToken)
        => organizationMembershipsApiQueryService.TryGetAsync(userId, resource, cancellationToken);
}
```

- It implements `IAuthorizationHandler` directly instead of `AuthorizationHandler<TRequirement, TResource>`. The real class meets a second requirement from the same membership read, and `PendingRequirements` lets one database query answer both.
- `HasMinimumRole` is `IsOwner || Role >= minimumRole`. The membership query joins the workspace to its organization, so *"is this workspace in the caller's organization?"* is one SQL statement.
- A support account with the `BlouppyAdmin` role is let in by a second handler, `BlouppyAdminAuthorizationHandler`, on the same `MinimumRoleRequirement`. That works because handlers of one requirement combine with OR, and it never touches the database.

A small extension block on `IAuthorizationService` turns the result into a `bool`, and the controller reads like the rule:

```csharp
[HttpPut("{id:int}", Name = RouteNames.Api.Workspaces.Update)]
public async Task<ActionResult<WorkspaceDto>> UpdateAsync(
    int id,
    WorkspaceEditionDto workspaceEditionDto,
    CancellationToken cancellationToken)
{
    if (!await authorizationService.IsAuthorizedAsync(User, new WorkspaceId(id), Policies.Manage))
    {
        return Forbid();
    }

    // ... the write through IWorkspacesService
}
```

The controller itself carries a plain `[Authorize]`, and the resource check happens inside each action.


## 403 or 404: do not reveal what exists
A check that loads the workspace first and answers `404` when it is missing, `403` when it belongs to someone else, tells any authenticated caller which ids exist. With sequential ids, that is a listing of every customer's workspaces.

Authorizing on the id before reading anything gives the same answer for both cases. In the Starter, a workspace that does not exist has no membership, and a workspace of another organization has a membership with no role: both fail the requirement, and both return `403`. The `404` that follows the read is only reached by someone allowed to see the workspace.

The other common choice is to answer `404` for both. That hides even the fact that an id is valid for *some* organization, at the cost of a less precise message for a user who simply lacks the role. What matters is that the two cases are indistinguishable; pick one and apply it everywhere.


## Scopes: widen by scope, never by client
When the same API serves the browser and tokens issued to scripts, it is tempting to write `if (clientId == "cli") ...`. Each new client then needs its own branch, and a forgotten one inherits whatever the default was.

The Starter checks the **scope** in each policy instead, in `ApiScopes`:

```csharp
public static class ApiScopes
{
    public const string Browser = "blouppy_api";

    public const string Read = "blouppy.read";

    public const string Write = "blouppy.write";

    public static IReadOnlyList<string> Reading { get; } = [Browser, Read, Write];

    public static IReadOnlyList<string> Writing { get; } = [Browser, Write];
}
```

A read token passes `Read` and nothing more, a write token also passes `Contribute`, and only the browser's scope passes `Manage`. A new kind of client is a set of scopes, and the policies already know what each scope allows. For the writes that no resource policy guards, such as marking a notification as read, a `WriteScopeRequirement` in the default policy succeeds on `GET`, `HEAD` and `OPTIONS`, or when the user has a scope from `ApiScopes.Writing`.


## Default and fallback policies
Two policies are easy to confuse:

- `DefaultPolicy` is what a bare `[Authorize]` means. Out of the box, it only requires an authenticated user.
- `FallbackPolicy` applies to endpoints with **no** authorization metadata at all. It is `null` by default, so an endpoint without `[Authorize]` is anonymous.

The Starter sets `DefaultPolicy` to its `ApplicationAccess` policy (authenticated, a reading scope, the `ApplicationAccess` role and the write-scope requirement), so every `[Authorize]` controller gets all of it. Its `FallbackPolicy` line is commented out: the API relies on each controller declaring `[Authorize]`, and the anonymous ones, such as the public plan catalog, declare `[AllowAnonymous]`. Setting the fallback to the same policy is the safer default, because then a controller that forgets the attribute is closed instead of open.


## Testing the handlers
A handler is a plain class: we can build an `AuthorizationHandlerContext` by hand, call `HandleAsync` and look at `HasSucceeded`. The Starter wraps that construction in a small `AuthorizationHandlerContextBuilder`:

```csharp
[Fact]
public async Task Should_not_succeed_when_role_is_below_minimum()
{
    // Arrange
    var userId = _fixture.Create<UserId>();
    var resource = _fixture.Create<TestResourceId>();

    Given_a_Membership_found(OrganizationRole.Viewer);

    var context = AuthorizationHandlerContextBuilder
        .For(new MinimumRoleRequirement(OrganizationRole.Member))
        .OnResource(resource)
        .WithSubject(subject => subject
            .WithId(userId))
        .Build();

    // Act
    await _sut.HandleAsync(context);

    // Assert
    context.HasSucceeded
        .Should()
        .BeFalse();
}
```

The rule is tested once, through a test-only subclass of the base handler with a stubbed lookup: owner, role above, equal and below the minimum, membership not found, subject claim missing. The concrete handlers only prove they resolve the membership from the right resource. The integration tests then call real endpoints as a viewer, a member, an admin and a user with no organization, and assert the status codes, which is what catches a controller that forgot its check.


## What it costs, and when not to bother
- **A query per check.** Every resource-based call reads the membership. It is one indexed join, but an action that checks twice pays twice.
- **The check is manual.** Nothing forces an action to call `IsAuthorizedAsync`. Only the integration tests notice a missing one.
- **Indirection.** A reader of the controller sees `Policies.Manage` and has to open the registration and a handler to learn what it means.

If the application has no tenants and no per-resource ownership, roles and a single `[Authorize]` are enough, and a policy with `RequireRole` covers the rest. A custom handler starts paying for itself when the same data-dependent rule appears in a second controller.


## Conclusion
Policies give a name to a rule, requirements make it data, and handlers keep the code that decides in one place. For multi-tenant data, the resource-based form with an id as the resource answers *"is this in the caller's organization?"* before anything is read, which also keeps a missing resource and a forbidden one indistinguishable. Let the scopes widen access per policy, set a fallback policy so that forgetting `[Authorize]` fails closed, and test each handler with a hand-built context.


## References
- [Policy-based authorization in ASP.NET Core (Microsoft Learn)](https://learn.microsoft.com/aspnet/core/security/authorization/policies) — requirements, handlers and their AND/OR semantics.
- [Resource-based authorization in ASP.NET Core (Microsoft Learn)](https://learn.microsoft.com/aspnet/core/security/authorization/resourcebased) — `IAuthorizationService.AuthorizeAsync` with a resource.
- [Role-based authorization in ASP.NET Core (Microsoft Learn)](https://learn.microsoft.com/aspnet/core/security/authorization/roles) — `[Authorize(Roles = ...)]` and `RequireRole`.
- [Claims-based authorization in ASP.NET Core (Microsoft Learn)](https://learn.microsoft.com/aspnet/core/security/authorization/claims) — `RequireClaim` with allowed values.
- [Require authenticated users (Microsoft Learn)](https://learn.microsoft.com/aspnet/core/security/authorization/secure-data#require-authenticated-users) — setting a `FallbackPolicy`.
- [OWASP: Insecure Direct Object Reference Prevention](https://cheatsheetseries.owasp.org/cheatsheets/Insecure_Direct_Object_Reference_Prevention_Cheat_Sheet.html) — why every access to an id needs its own check.
- [RFC 9110: 403 Forbidden](https://www.rfc-editor.org/rfc/rfc9110#name-403-forbidden) — the status code, and the option of answering 404 instead.
