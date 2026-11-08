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

A modular monolith splits one deployable into modules that are supposed to stay apart. Sooner or later, one of them needs something the other owns. The AI module must know which organization pays for a workspace. The workspaces domain must take a person off its teams when that person leaves the organization. How we write that one line decides whether the modules stay modules.

In this article, we will compare the five answers usually given to "how does module A ask module B?": injecting B's repository or service, sharing a database query, sending a request through an in-process mediator, publishing integration events for everything, and a small public contract project. We will see which one [Blouppy Starter](https://starter.blouppy.com/) retained, why, and when a simpler answer is enough.


## Two kinds of need
Before comparing the solutions, it helps to separate what the caller wants:

- **A fact, now.** The caller applies a rule of its own and needs a piece of the other module's data first: "which organization owns workspace 12?".
- **A reaction, later.** Something changed in B, and A does its part afterwards: "a member was removed, so drop their team memberships". Nobody waits for an answer.

Most of the confusion comes from answering both needs with the same tool.


## Option 1: inject the other module's repository or service
The first idea is the shortest. The AI module needs a workspace, the workspaces repository exists, so we inject it:

```csharp
internal sealed class WorkspaceDescriptionDraftService(
    IWorkspacesRepository workspacesRepository)
{
    public async Task<OrganizationId?> FindPayerAsync(WorkspaceId workspaceId, CancellationToken cancellationToken)
    {
        var workspace = await workspacesRepository.TryGetAsync(workspaceId, cancellationToken);

        return workspace.Found
            ? workspace.Value.OrganizationId
            : null;
    }
}
```

It works on day one, and it is the option we rejected first:

- **The caller holds the other module's entity.** With EF Core, a repository returns a [tracked](https://learn.microsoft.com/ef/core/change-tracking/) entity, the `DbContext` is scoped and shared by every module inside one request, and the unit of work saves the whole context. Any public mutator the caller touches by accident is persisted by the next commit, whoever makes it.
- **A service is worse.** `IOrganizationMembersService` has `TryUpdateAsync` and `TryDeleteAsync`. Handing it to Workspaces would let Workspaces remove someone from an organization.
- **The coupling is total.** Renaming a property in B breaks A.
- **Cycles become easy.** Once A injects B's repository and B injects A's, the two modules are one module with two folder names.


## Option 2: share a database view or query
The second idea skips the other module's code entirely: both live in the same database, so the caller writes a query, or a view, against the other's tables.

It is fast and needs no project reference. Its cost is that it **bypasses the owner's rules**. In the Starter, an organization's _Built-in AI_ switch is on unless an administrator turned it off, and there is no settings row until someone does:

```csharp
public async Task<bool> IsBuiltInAiEnabledAsync(
    OrganizationId organizationId,
    CancellationToken cancellationToken = default)
{
    var organizationSettings = await organizationSettingsRepository.TryGetAsync(organizationId, cancellationToken);

    return organizationSettings.Found
        ? organizationSettings.Value.IsBuiltInAiEnabled
        : OrganizationSettings.DefaultFor(organizationId).IsBuiltInAiEnabled;
}
```

A query written in the AI module against the settings table would find no row and have to guess. The default lives in the Organizations domain's code, and only that code knows it. It also freezes B's schema for readers B does not know about.

We kept this option where it belongs: **the read side**. A `GET` that lists organization members with their names and avatars is one SQL projection joining members and users, in a dedicated read repository ([separating reads and writes](/blog/2026-06-21-separating-reads-and-writes-without-mediatr/) explains that split). A screen has no rule to enforce, so reading across tables is what it should do. What we refused is a **write-side rule** reading another module's tables.


## Option 3: an in-process mediator
The third idea removes the compile-time reference: the caller sends a request object, and a handler in the other module answers it.

```csharp
public sealed record GetWorkspaceOrganization(WorkspaceId WorkspaceId) : IRequest<OrganizationId?>;

// In the AI module
var organizationId = await mediator.Send(new GetWorkspaceOrganization(workspaceId), cancellationToken);
```

It looks decoupled, but the request type and its result still have to live in a project both modules reference. That project is a public contract, only spelled as messages instead of an interface. What the mediator adds is indirection:

- **The dependency disappears from the reference graph.** Nothing says "the AI module asks Workspaces" any more, so a tool that reads assembly references cannot detect a cycle.
- **A missing handler fails at run time**, at the first call, where a missing registration of an interface fails as soon as the container is validated at startup.

The Starter uses no mediator for this, nor anywhere else. A plain interface gives the same decoupling with the dependency still visible.


## Option 4: integration events for everything
The fourth idea goes the other way: modules never ask, they only listen. Organizations publishes every change, and Workspaces keeps a local copy of what it needs.

This gives real autonomy: Workspaces keeps working while Organizations is slow. The Starter does use it where it fits: entitlements are published by the Billing module and projected on the organization side, so no workspace creation ever calls Billing ([the billing module](/blog/2026-10-01-billing-module-behind-an-adapter/)).

As the only mechanism, it costs too much:

- **Eventual consistency everywhere.** The copy is late by definition. A rule that must hold **before** a write cannot be expressed as a reaction **after** it.
- **A projection per need.** Each fact becomes a table, a migration, a handler and a backfill, all coping with messages that arrive late, twice or out of order.


## Option 5, the one retained: a public contract project
Each domain that peers need to ask exposes one more project, `Blouppy.<Domain>.PublicData`. It declares **one service**, `IXxxPublicDataService`, whose methods return **a fact** (a `bool`, a nullable typed id) or an **immutable `XxxPublicDataDto`**, never a model. Here is the whole of Workspaces' contract:

```csharp
namespace Blouppy.Workspaces.PublicData;

public interface IWorkspacesPublicDataService
{
    /// <summary>
    /// The organization a workspace belongs to, or nothing when there is no such workspace.
    /// </summary>
    Task<OrganizationId?> TryGetOrganizationIdAsync(
        WorkspaceId workspaceId,
        CancellationToken cancellationToken = default);
}
```

One method, added the day the AI module needed it. The implementation stays `internal sealed` in `Blouppy.Workspaces`, reads through the domain's own repository and lets nothing but the id out:

```csharp
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

The AI module references `Blouppy.Workspaces.PublicData` and nothing else of Workspaces. Its service, trimmed:

```csharp
internal sealed class WorkspaceDescriptionDraftService(
    IAiGateway gateway,
    IWorkspacesPublicDataService workspacesPublicDataService,
    IValidator<WorkspaceDescriptionFromName> validator,
    ILogger<WorkspaceDescriptionDraftService> logger) : IWorkspaceDescriptionDraftService
{
    public async Task<ValidationResult<WorkspaceDescriptionDraft>> TryDraftFromNameAsync(
        WorkspaceDescriptionFromName request,
        CancellationToken cancellationToken = default)
    {
        // ... validation

        var organizationId = await workspacesPublicDataService.TryGetOrganizationIdAsync(request.WorkspaceId, cancellationToken);

        // Deleted since the validator saw it.
        if (organizationId is null)
        {
            return ValidationResult.Failure<WorkspaceDescriptionDraft>(new Dictionary<string, string[]>
            {
                [nameof(WorkspaceDescriptionFromName.WorkspaceId)] = ["The workspace does not exist."]
            });
        }

        // ... one call through the gateway, billed to organizationId
    }
}
```

A few decisions make this hold:

- **`.PublicData` is separate from `.Abstractions`.** `.Abstractions` is the contract the Web calls, writes included. `.PublicData` carries only what peers read.
- **`.PublicData` references the SharedKernel alone** and declares every type it returns. Since project references are transitive, a contract that named `Workspace` would hand the entity to every caller. Declared in `.PublicData`, no path leads from the caller to the model.
- **One public service per providing domain**, not one per caller. Past seven or eight members, the boundary is probably misplaced.
- **One DTO per model**, not one per need. `OrganizationEntitlementsPublicDataDto` is the public shape of the entitlements; a peer missing a property adds it there, it does not get a second record.
- **A call is synchronous, in the same transaction scope, against current data.** That is what a rule applied before a write needs.

The workspace limit check, which asks Organizations for its entitlements in the same way, is walked through in [hexagonal architecture in .NET](/blog/2026-05-04-hexagonal-architecture-in-dotnet/).


## Integration events for what changes state
`.PublicData` reads; it never changes anything in the provider. When a change in one domain must be followed by work in another, the Starter publishes an integration event through the outbox, and the handler belongs to the domain that reacts. Organizations removes a member and publishes `OrganizationMemberRemovedIntegrationEvent` without knowing who listens. Workspaces listens, and asks a fact before acting:

```csharp
internal sealed class RemoveTeamMembershipsWhenOrganizationMemberRemovedIntegrationEventHandler(
    ITeamsRepository teamsRepository,
    IOrganizationsPublicDataService organizationsPublicDataService,
    ILogger<RemoveTeamMembershipsWhenOrganizationMemberRemovedIntegrationEventHandler> logger)
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

The two mechanisms work together: by the time the event is handled, the person may have been invited back, so the handler asks the current fact instead of trusting the message. How the event leaves with the transaction that removed the member is the subject of [domain events, integration events and the outbox](/blog/2026-05-28-domain-events-vs-integration-events-and-the-outbox/). Domain events stay inside their domain: they are declared in a `.Models` project, which a peer cannot reference.

So the rule of the Starter fits in one table:

| The caller needs | It uses | Shape |
| --- | --- | --- |
| a yes/no or an id, for a rule of its own | the provider's `IXxxPublicDataService` | synchronous, a fact |
| several properties of one model, in the same flow | its `XxxPublicDataDto` | synchronous, an immutable copy |
| nothing back, something must happen after the change | an integration event | asynchronous, no answer |


## Holding the line with tests
A convention that only review enforces erodes. `DomainBoundaryTests` reads the compiled assemblies and fails the build on eight rules, among them: a domain references neither another domain nor its models; a domain injects no repository owned by another domain, since the persistence ports are shared and would otherwise be a way around the first rule; `.PublicData` references the SharedKernel alone; and the `A → B.PublicData` graph has no cycle.

That last rule is the one people forget. Splitting the contract out makes mutual dependencies legal for the compiler: Workspaces referencing `Organizations.PublicData` while Organizations references `Workspaces.PublicData` builds fine. The test collects the edges from `Assembly.GetReferencedAssemblies()` and walks them:

```csharp
var edges = Domains.ToDictionary(
    domain => domain.Name,
    domain =>
    {
        var referenced = ReferencedAssemblyNames(domain.Implementation);

        // A domain references its own .PublicData to implement it; only
        // the edges to its peers can form a cycle.
        return Domains
            .Where(peer => peer != domain
                && peer.PublicData is not null
                && referenced.Contains(peer.PublicData.GetName().Name!))
            .Select(peer => peer.Name)
            .ToArray();
    });

var cycle = FindCycle(edges);

cycle
    .Should()
    .BeNull($"the public contracts must stay acyclic, but this cycle exists: {string.Join(" → ", cycle ?? [])}");
```

This is also why the mediator lost: with requests instead of references, this test would have nothing to read. The other rules are covered in [architecture tests that fail the build](/blog/2026-07-03-architecture-tests-that-fail-the-build/).


## What it costs
- **More projects.** A `.PublicData` per domain that peers ask.
- **Copies that can drift.** A property added to a model does not reach its DTO. That is the point, but a peer can end up served by a shape nobody refreshed.
- **Repetitive names.** `Blouppy.Users.PublicData.UserPublicDataDto` says "public data" twice, on purpose: at any call site, the type name alone says the object crossed a boundary.
- **Calls in a loop.** A peer asking a fact per item is N calls. The answer is a method that takes a set, like `GetReadersAmongAsync(organizationId, userIds)`, not a shared query.


## When a simpler approach is enough
It depends on how many modules there are and who works on them:

- **Two or three modules, one small team.** Folders and `internal` in one project, with a review rule, may be enough. The contract project pays off once a second team, or a fifth module, arrives.
- **Nobody asks the module anything.** Then it needs no `.PublicData` at all. In the Starter, Notifications, Audit, Webhooks, Privacy and Ai declare none, and the project appears with the first peer that needs a fact.
- **Screens and reports.** A read model that joins across modules is the simplest correct answer. Do not route a list page through five public services.
- **A module meant to become a service.** Lean further toward events and local projections, because a synchronous call becomes a network call the day it moves.


## Conclusion
Injecting a repository hands over the other module's entities. A shared query skips its rules. A mediator hides the dependency without removing it. Events for everything make every rule eventually consistent. The Starter keeps two mechanisms with clear jobs: a small `.PublicData` contract that returns facts and immutable copies when a rule needs current data, and integration events when a change must be followed by work elsewhere. Architecture tests then keep the line where it was drawn. The back end of [Blouppy Starter](https://starter.blouppy.com/) is built this way, with Workspaces and Organizations as the example.


## References
- [Hexagonal architecture (Alistair Cockburn)](https://alistair.cockburn.us/hexagonal-architecture/) — the ports-and-adapters pattern behind one contract per domain.
- [Bounded context (Martin Fowler)](https://martinfowler.com/bliki/BoundedContext.html) — why each module keeps its own model.
- [Change tracking in EF Core (Microsoft Learn)](https://learn.microsoft.com/ef/core/change-tracking/) — why a tracked entity handed to another module is a risk.
- [Domain events: design and implementation (Microsoft Learn)](https://learn.microsoft.com/dotnet/architecture/microservices/microservice-ddd-cqrs-patterns/domain-events-design-implementation) — domain events versus integration events.
- [Assembly.GetReferencedAssemblies (Microsoft Learn)](https://learn.microsoft.com/dotnet/api/system.reflection.assembly.getreferencedassemblies) — the API the boundary tests read the graph from.
- [NetArchTest.Rules (NuGet)](https://www.nuget.org/packages/NetArchTest.Rules) — the library behind the type-level rules.
