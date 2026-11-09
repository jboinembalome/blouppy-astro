---
templateKey: 'blog-post'
title: 'How two modules talk in a modular monolith'
date: 2027-01-19T09:00:00.000Z
author: Jimmy Boinembalome
authorimage: /img/jimmy.jpg
category: C#
topic: 'Architecture'
illustration: 1
categorycolor: bg-purple-100 text-purple-800
featuredpost: true
description: >-
  Learn the five ways one module of a .NET modular monolith can ask another for something, what each one costs, and why a small public contract plus integration events wins.
tags:
  - Development
  - C#
  - Architecture
  - DDD
---

A modular monolith splits one deployable into modules that are supposed to stay apart. Sooner or later, one of them needs something another owns. The AI module must know which organization pays for a workspace. The workspaces domain must take a person off its teams when that person leaves the organization. How we write that one line decides whether the modules stay modules.


## A fact now, or a reaction later
It helps to separate two needs first:

- **A fact, now.** The caller applies a rule of its own and needs a piece of the other module's data first: "which organization owns workspace 12?".
- **A reaction, later.** Something changed in B, and A does its part afterwards: "a member was removed, so drop their team memberships". Nobody waits for an answer.

Most of the confusion comes from answering both with the same tool.


## The usual answers, and why they fall short
**Inject the other module's repository.** It is the shortest line, and the most dangerous. With EF Core, the repository returns a [tracked](https://learn.microsoft.com/ef/core/change-tracking/) entity. The `DbContext` is shared by every module within a request, and the unit of work saves all of it. Any setter the caller touches by accident is persisted. Injecting a service is worse: `IOrganizationMembersService` can delete a member, and Workspaces has no business doing that.

**Query the other module's tables.** Both modules live in the same database, so why not? Because it skips the owner's rules. In [Blouppy Starter](https://starter.blouppy.com/), an organization's _Built-in AI_ switch is on until an administrator turns it off, and there is no settings row before that. A query from the AI module finds no row and has to guess. The default lives in the Organizations code, and only there. This answer is fine on the read side: a page that lists members with their names is one SQL projection, and a screen has no rule to enforce ([separating reads and writes](/blog/2026-06-21-separating-reads-and-writes-without-mediatr/)).

**Send a request through a mediator.** It looks decoupled, but the request type and its result still live in a project both modules reference. That is a public contract spelled as messages. The mediator only hides the dependency from the reference graph, and a missing handler fails at the first call instead of at startup.

**Publish events for everything.** Each module keeps a local copy of what it needs from the others. That gives real autonomy, and the Starter uses it where it fits: Billing publishes entitlements and the organization side projects them ([the billing module](/blog/2026-10-01-billing-module-behind-an-adapter/)). As the only mechanism, it makes every rule eventually consistent. A rule that must hold **before** a write cannot be a reaction **after** it.


## A small public contract for facts
The Starter gives each domain that peers need to ask one more project, `Blouppy.<Domain>.PublicData`. It declares one service whose methods return a fact (a `bool`, a nullable typed id) or an immutable DTO, never a model. Here is the whole of Workspaces' contract and its implementation:

```csharp
public interface IWorkspacesPublicDataService
{
    Task<OrganizationId?> TryGetOrganizationIdAsync(
        WorkspaceId workspaceId,
        CancellationToken cancellationToken = default);
}

internal sealed class WorkspacesPublicDataService(
    IWorkspacesRepository workspacesRepository) : IWorkspacesPublicDataService
{
    public async Task<OrganizationId?> TryGetOrganizationIdAsync(
        WorkspaceId workspaceId,
        CancellationToken cancellationToken = default)
    {
        var workspace = await workspacesRepository.TryGetAsync(workspaceId, cancellationToken);

        return workspace.Found
            ? workspace.Value.OrganizationId
            : null;
    }
}
```

One method, added the day the AI module needed it. The AI module references `Blouppy.Workspaces.PublicData` and nothing else of Workspaces. It gets an id, not a tracked `Workspace`.

A few decisions keep it honest:

- **`.PublicData` is not `.Abstractions`.** `.Abstractions` is what the Web calls, writes included. `.PublicData` carries only what peers read.
- **It references the SharedKernel alone** and declares every type it returns. Project references are transitive, so a contract that named `Workspace` would hand the entity to every caller.
- **One service per providing domain, one DTO per model.** A peer missing a property adds it to the existing DTO. It does not get a record of its own.
- **The call is synchronous, against current data.** That is what a rule checked before a write needs.

A module nobody asks needs no `.PublicData` at all. In the Starter, Notifications, Audit, Webhooks, Privacy and Ai declare none.


## Integration events for reactions
`.PublicData` reads; it never changes anything in the provider. When a change in one domain must be followed by work in another, the producer publishes an integration event through the outbox, and the handler belongs to the domain that reacts. Organizations removes a member and does not know who listens. Workspaces listens. This handler is trimmed of its logging:

```csharp
internal sealed class RemoveTeamMembershipsWhenOrganizationMemberRemovedIntegrationEventHandler(
    ITeamsRepository teamsRepository,
    IOrganizationsPublicDataService organizationsPublicDataService)
    : IIntegrationEventHandler<OrganizationMemberRemovedIntegrationEvent>
{
    public async Task HandleAsync(
        OrganizationMemberRemovedIntegrationEvent @event,
        CancellationToken cancellationToken = default)
    {
        var stillInOrganization = await organizationsPublicDataService.GetReadersAmongAsync(
            @event.OrganizationId,
            [@event.MemberId],
            cancellationToken);

        // Invited back since: the memberships are current, not left behind.
        if (stillInOrganization.Count > 0)
        {
            return;
        }

        await teamsRepository.RemoveMemberAsync(@event.OrganizationId, @event.MemberId, cancellationToken);
    }
}
```

The two mechanisms work together. The event can arrive late, so the handler asks the current fact instead of trusting the message. How the event leaves with the transaction that removed the member is the subject of [domain events, integration events and the outbox](/blog/2026-05-28-domain-events-vs-integration-events-and-the-outbox/).

`GetReadersAmongAsync` also shows how to avoid N calls in a loop: the method takes a set of users, not one.


## Keeping the line
A convention that only review enforces erodes. `DomainBoundaryTests` reads the compiled assemblies and fails the build when a domain references another domain or its models, injects a repository another domain owns, or when a `.PublicData` references more than the SharedKernel.

One more rule is easy to forget. Splitting the contract out makes mutual dependencies legal: Workspaces can reference `Organizations.PublicData` while Organizations references `Workspaces.PublicData`, and it builds. So the test collects the edges from `Assembly.GetReferencedAssemblies()` and fails on a cycle. With a mediator, it would have nothing to read. The other rules are in [architecture tests that fail the build](/blog/2026-07-03-architecture-tests-that-fail-the-build/).

All of this pays off from a few modules and more than one team. With two or three modules and one small team, folders and `internal` in one project may be enough.


## References
- [Bounded context (Martin Fowler)](https://martinfowler.com/bliki/BoundedContext.html) — why each module keeps its own model.
- [Change tracking in EF Core (Microsoft Learn)](https://learn.microsoft.com/ef/core/change-tracking/) — why a tracked entity handed to another module is a risk.
- [Domain events: design and implementation (Microsoft Learn)](https://learn.microsoft.com/dotnet/architecture/microservices/microservice-ddd-cqrs-patterns/domain-events-design-implementation) — domain events versus integration events.
- [Hexagonal architecture in .NET](/blog/2026-05-04-hexagonal-architecture-in-dotnet/) — the workspace limit check, which asks Organizations in the same way.
