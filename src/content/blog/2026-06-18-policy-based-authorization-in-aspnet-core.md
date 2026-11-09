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

Most APIs start with `[Authorize]` on every controller and a role check here and there. That holds until the question becomes *"may this person edit **this** workspace?"*. A role is a property of the user. The answer now depends on the user **and** the data, so the check moves into the action as an `if` that reads the database. Soon every controller has its own slightly different copy.

ASP.NET Core's policy-based authorization gives that rule one name and one place.


## Requirements and handlers
A **policy** is a named list of **requirements**. A requirement is data; a **handler** is the code that decides. The classic example is a minimum age:

```csharp
public sealed class MinimumAgeRequirement(int minimumAge) : IAuthorizationRequirement
{
    public int MinimumAge { get; } = minimumAge;
}

internal sealed class MinimumAgeHandler(TimeProvider timeProvider)
    : AuthorizationHandler<MinimumAgeRequirement>
{
    protected override Task HandleRequirementAsync(
        AuthorizationHandlerContext context,
        MinimumAgeRequirement requirement)
    {
        var today = DateOnly.FromDateTime(timeProvider.GetUtcNow().UtcDateTime);

        if (DateOnly.TryParse(context.User.FindFirstValue(ClaimTypes.DateOfBirth), out var birthDate)
            && birthDate.AddYears(requirement.MinimumAge) <= today)
        {
            context.Succeed(requirement);
        }

        return Task.CompletedTask;
    }
}

builder.Services.AddAuthorization(options =>
    options.AddPolicy("Adults", policy => policy
        .RequireAuthenticatedUser()
        .AddRequirements(new MinimumAgeRequirement(18))));
```

The semantics are the part to remember. Inside a policy, requirements combine with **AND**. For one requirement, handlers combine with **OR**: one `Succeed` is enough. A handler that does nothing means *"I cannot say yes"*. `context.Fail()` means *"no, whatever the others say"*, and is rarely what we want.

Handlers are registered as `IAuthorizationHandler` and may take dependencies like any service.


## A check on the resource
`[Authorize(Policy = "...")]` runs before the action, so it never sees the resource. For a rule that depends on the data, the action calls `IAuthorizationService.AuthorizeAsync(User, resource, policy)`, and the handler receives the resource in `context.Resource`.

The textbook form passes a loaded entity. That means reading the entity before we know whether the caller may see it. Passing an **identifier** instead, and letting the handler look up what it needs, avoids the read and keeps the controller thin.

[Blouppy Starter](https://starter.blouppy.com/) does this for every organization-scoped rule. They all ask the same question: *"what is this user's role in the organization this resource belongs to?"*. Members are `Viewer`, `Member` or `Admin`, and the owner passes every check. Three policies, `Read`, `Contribute` and `Manage`, each carry a `MinimumRoleRequirement`. One generic handler answers them, here trimmed to the role check:

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
        var subject = context.User.FindFirstValue(BlouppyClaimTypes.Subject);

        if (requirements.Count == 0 || string.IsNullOrEmpty(subject))
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
```

The resource is a [strongly typed id](/blog/2026-05-16-strongly-typed-ids-with-ef-core/). `WorkspaceAuthorizationHandler` derives from `MembershipAuthorizationHandlerBase<WorkspaceId>` and only says how to find the membership. Its query joins the workspace to its organization, so *"is this workspace in the caller's organization?"* is one SQL statement. The class implements `IAuthorizationHandler` directly because the real one meets a second requirement from the same read, and `PendingRequirements` lets one query answer both.

The controller then reads like the rule. A small extension on `IAuthorizationService` turns the result into a `bool`:

```csharp
[HttpPut("{id:int}")]
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

The policy names are constants, so a typo is a compile error. The weak spot is that nothing forces an action to make the call. Only the integration tests, which hit real endpoints as a viewer, a member and an outsider, notice a missing one.


## 403 or 404
A check that loads the workspace first, then answers `404` when it is missing and `403` when it belongs to someone else, tells any caller which ids exist. With sequential ids, that is a listing of every customer's workspaces.

Authorizing on the id before reading anything gives one answer for both cases. A workspace that does not exist has no membership. A workspace of another organization gives the caller no role in it. Both fail the requirement and both return `403`. Answering `404` for both is the other valid choice. What matters is that the two cases look the same.


## Widen by scope, never by client
When one API serves the browser and tokens for scripts, it is tempting to write `if (clientId == "cli")`. Each new client then needs its own branch. The Starter puts a scope in each policy instead. Any token passes `Read`, a write token also passes `Contribute`, and only the browser's scope passes `Manage`. A new kind of client is just a set of scopes.


## Default and fallback policies
`DefaultPolicy` is what a bare `[Authorize]` means; out of the box it only requires an authenticated user. `FallbackPolicy` applies to endpoints with **no** authorization metadata, and is `null` by default, so an endpoint without `[Authorize]` is anonymous.

The Starter sets `DefaultPolicy` to its application-access policy and leaves the fallback commented out: every controller declares `[Authorize]` or `[AllowAnonymous]`. Setting the fallback to the same policy is the safer choice, because a controller that forgets the attribute is then closed instead of open.

A handler is a plain class, so its tests build an `AuthorizationHandlerContext` by hand, call `HandleAsync` and check `HasSucceeded`. If the application has no tenants and no per-resource ownership, none of this is needed: roles and `[Authorize]` are enough.


## References
- [Policy-based authorization in ASP.NET Core](https://learn.microsoft.com/aspnet/core/security/authorization/policies) — Microsoft Learn: requirements, handlers and their AND/OR semantics.
- [Resource-based authorization in ASP.NET Core](https://learn.microsoft.com/aspnet/core/security/authorization/resourcebased) — Microsoft Learn: `AuthorizeAsync` with a resource.
- [Require authenticated users](https://learn.microsoft.com/aspnet/core/security/authorization/secure-data#require-authenticated-users) — Microsoft Learn: setting a `FallbackPolicy`.
- [OWASP: Insecure Direct Object Reference Prevention](https://cheatsheetseries.owasp.org/cheatsheets/Insecure_Direct_Object_Reference_Prevention_Cheat_Sheet.html) — why every access to an id needs its own check.
