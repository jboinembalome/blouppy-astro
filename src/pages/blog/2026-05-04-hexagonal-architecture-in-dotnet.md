---
templateKey: 'blog-post'
title: 'Hexagonal architecture in .NET: going beyond Clean Architecture'
date: 2026-05-04T09:00:00.000Z
updated: 2026-11-07T09:00:00.000Z
author: Jimmy Boinembalome
authorimage: /img/jimmy.jpg
category: C#
topic: 'Architecture'
illustration: 3
categorycolor: bg-purple-100 text-purple-800
featuredpost: true
featuredimage: /img/hexagonal-architecture-in-dotnet.jpg
description: >-
  Learn how to move from a layered Clean Architecture to ports and adapters in .NET, with one project per domain and explicit doors between domains.
tags:
  - Development
  - C#
  - Architecture
  - ASP.NET Core
  - DDD
---

In the [Introduction to Clean Architecture](https://www.blouppy.com/blog/2023-05-28-introduction-to-clean-architecture/), we built a ToDoList API with `Domain`, `Application`, `Infrastructure` and `Api` projects. For one feature, that works. With many, every feature lands in the same `Application` and `Infrastructure` projects, and nothing stops a service from reaching into another feature's repository "just this once". Soon a change to billing breaks invitations.

The layers were never the problem. The problem is that they are the *only* boundaries we drew.

In this article, we take that architecture one step further with [hexagonal architecture](https://alistair.cockburn.us/hexagonal-architecture/), also called ports and adapters: one project per domain, driving and driven ports, two kinds of contracts and one composition root.


## A different question
A layered design asks "**which layer is this in?**". A hexagonal design asks two other questions:

1. **Whose rule is this?** The answer is a domain: Workspaces, Organizations, Users...
2. **Is this a port or an adapter?** A port is an interface the domain owns. An adapter is the technology plugged into it.

The vocabulary is small:
- A **driving port** is what the outside may ask the domain to do (`IWorkspacesService`).
- A **driven port** is what the domain needs from the outside (`IWorkspacesRepository`, `IFileStorage`, `IEmailSender`).
- A **driving adapter** turns a request into a call on a driving port: an ASP.NET Core controller, a message consumer.
- A **driven adapter** implements a driven port with a real technology: EF Core, SMTP, S3.
- The **composition root** is the one place that wires adapters to ports.

```text:clipboard=false
   driving adapters                                     driven adapters
 (controllers, consumers)                          (EF Core, SMTP, S3, bus)
          │                                                  │
          ▼                                                  ▼ implements
  IWorkspacesService ──► Blouppy.Workspaces ──► IWorkspacesRepository, IFileStorage...
   (driving port)          (the domain)              (driven ports)
```

Every reference points inward: the domain and the adapters both reference the ports, and the domain never references EF Core, the bus or the mail library.


## One project per domain
In [Blouppy Starter](https://starter.blouppy.com/), the code base this article comes from, each domain is split into up to four projects:

- `Blouppy.Workspaces.Models`: entities, value objects and domain events. It references the `SharedKernel` and nothing else.
- `Blouppy.Workspaces.Abstractions`: the contract **the Web** calls, `IWorkspacesService` and its input records.
- `Blouppy.Workspaces.PublicData`: the contract **other domains** call, with its own DTOs.
- `Blouppy.Workspaces`: the implementation. Everything is `internal sealed` except `AddWorkspacesDomain()`.

The implementation's project references tell the whole story:

```xml
<ItemGroup>
  <ProjectReference Include="..\Blouppy.Workspaces.Abstractions\Blouppy.Workspaces.Abstractions.csproj" />
  <ProjectReference Include="..\Blouppy.Workspaces.PublicData\Blouppy.Workspaces.PublicData.csproj" />
  <ProjectReference Include="..\Blouppy.Organizations.PublicData\Blouppy.Organizations.PublicData.csproj" />
  <ProjectReference Include="..\Blouppy.Infrastructure.Database.Abstractions\Blouppy.Infrastructure.Database.Abstractions.csproj" />
  <ProjectReference Include="..\Blouppy.Infrastructure.Messaging.Abstractions\Blouppy.Infrastructure.Messaging.Abstractions.csproj" />
</ItemGroup>
```

- Its own two contracts.
- **One** peer, and only through its `.PublicData`: `Blouppy.Organizations` itself is out of reach.
- The two driven ports it uses, database and messaging: their `.Abstractions` projects, never the adapters.

No EF Core, no Wolverine, no RabbitMQ: the compiler does not let the domain see them. The model is plain C#: `Workspace` checks its invariants in its constructor with `Exceptions.ThrowIfNullOrWhiteSpace(name)` and the like, and carries an `OrganizationId`, not an `Organization`. A model never holds another domain's entity.


## Driving ports: the `.Abstractions` project
The driving port is what the Web may ask Workspaces to do:

```csharp
namespace Blouppy.Workspaces.Abstractions;

public interface IWorkspacesService
{
    Task<ValidationResult<Workspace>> TryAddAsync(WorkspaceCreation workspaceCreation, CancellationToken cancellationToken = default);
    Task<ValidationResult<Workspace>> TryUpdateAsync(WorkspaceEdition workspaceEdition, CancellationToken cancellationToken = default);
    Task<DeletionResult> TryDeleteAsync(WorkspaceId id, CancellationToken cancellationToken = default);
}
```

Its input records sit next to it. The controller is the driving adapter (one action shown):

```csharp
public class WorkspacesController(
    IWorkspacesService workspacesService,
    IWorkspacesApiQueryService workspacesApiQueryService,
    IWorkspaceDtoFactory workspaceDtoFactory,
    IAuthorizationService authorizationService,
    IUnitOfWork unitOfWork) : ControllerBase
{
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

- It checks the caller with [resource-based authorization](https://learn.microsoft.com/aspnet/core/security/authorization/resourcebased) first.
- It maps the HTTP DTO to the domain's input record, so HTTP shapes never enter the domain.
- It injects a port, never a repository, and commits through `IUnitOfWork` once the use case succeeds.
- Reads go through another port, `IWorkspacesApiQueryService` ([separating reads and writes](https://www.blouppy.com/blog/2026-06-21-separating-reads-and-writes-without-mediatr/) has its own article).


## Driven ports: what the domain needs
A driven port lives in a `Blouppy.Infrastructure.<Concern>.Abstractions` project, one per adapter. `IWorkspacesRepository` (`TryGetAsync`, `CountByOrganizationAsync`, `AddAsync`, `Update`, `DeleteAsync`...) is one; its adapter, `WorkspacesRepository`, is an `internal sealed` class over `BlouppyDbContext` in `Blouppy.Infrastructure.Database`.

A port shows its value best with two adapters behind it. `IFileStorage` (`SaveAsync`, `TryOpenReadAsync`, `DeleteAsync`, `DeleteFolderAsync`) says nothing about disks; the Privacy module saves the GDPR data export through it and keeps the returned path. The adapter's registration (trimmed) decides which implementation answers:

```csharp
// Read once at registration: the provider decides which services exist.
var provider = section.GetValue(nameof(FileStorageOptions.Provider), FileStorageProvider.LocalDisk);

if (provider == FileStorageProvider.S3)
{
    services
        .AddSingleton<IAmazonS3>(serviceProvider => CreateClient(
            serviceProvider.GetRequiredService<IOptions<FileStorageOptions>>().Value.S3))
        .AddSingleton<IFileStorage, S3FileStorage>();
}
else
{
    services.AddSingleton<IFileStorage, LocalDiskFileStorage>();
}
```

- `FileStorage:Provider` picks `LocalDiskFileStorage` (the default) or `S3FileStorage`, which works with AWS S3 and S3-compatible stores such as Cloudflare R2 or MinIO.
- Only `Blouppy.Infrastructure.FileStorage` references [`AWSSDK.S3`](https://docs.aws.amazon.com/sdk-for-net/v3/developer-guide/welcome.html). The Privacy module references the `.Abstractions` project and never sees the SDK.

Moving from a disk to a bucket is a configuration change, not a change to any caller.


## `.PublicData`: the door between domains
Workspaces must refuse a workspace beyond the plan's limit, but the limit belongs to Organizations. In the 2023 layout, the use case would have injected the organizations repository. Here it cannot: `Blouppy.Workspaces` references only `Blouppy.Organizations.PublicData`. The validator asks that door:

```csharp
private async Task<bool> HaveRoomForAnotherWorkspaceAsync(
    OrganizationId organizationId,
    CancellationToken cancellationToken)
{
    var entitlements = await _organizationsPublicDataService.GetEntitlementsAsync(organizationId, cancellationToken);

    // A null limit means unlimited, and costs no count query.
    if (entitlements.MaxWorkspaces is not { } maxWorkspaces)
    {
        return true;
    }

    var workspaces = await _workspacesRepository.CountByOrganizationAsync(organizationId, cancellationToken);

    return workspaces < maxWorkspaces;
}
```

It combines a **fact from Organizations**, through `IOrganizationsPublicDataService`, with a **count from Workspaces**, through its own repository.

`GetEntitlementsAsync` does not return the `OrganizationEntitlements` entity but a copy, declared in `.PublicData`:

```csharp
public sealed record OrganizationEntitlementsPublicDataDto(
    OrganizationId OrganizationId,
    int? MaxWorkspaces,
    bool AllowsOwnAiKey,
    int? MonthlyAiCredits,
    int? MonthlyAiCreditsPerMember,
    int? MonthlyAutomationAiCredits,
    bool AllowsSso = false);
```

### Why not reuse `.Abstractions`?
`.Abstractions` carries writes: handing `IOrganizationMembersService` to a peer would let Workspaces remove someone from an organization. `.PublicData` exposes only what peers need.

### Why a copy instead of the entity?
Repositories return entities **tracked** by a scoped `DbContext` that every domain shares within a request, and the unit of work saves the whole context. A peer could change a tracked entity (`entitlements.Update(...)` compiles), and the next commit would save it, whoever makes it. A copy cannot leak a change. And since `Blouppy.Organizations.PublicData` references the `SharedKernel` alone, no transitive reference leads from Workspaces to an Organizations entity.

Workspaces has its own `.PublicData`, and it is tiny on purpose: one method, `TryGetOrganizationIdAsync(WorkspaceId)`, added the day the AI module needed to know which organization pays for a workspace's description.

> **_Note:_** `.PublicData` is one of two doors. When the caller needs nothing back, an integration event is the other: Workspaces' `RemoveTeamMembershipsWhenOrganizationMemberRemovedIntegrationEventHandler` reacts to Organizations without Organizations knowing it exists. See [Domain events vs integration events](https://www.blouppy.com/blog/2026-05-28-domain-events-vs-integration-events-and-the-outbox/).


## The composition root
One project knows everything: `Blouppy.Web`. Each domain exposes one entry point, written as a [C# 14 extension block](https://learn.microsoft.com/dotnet/csharp/language-reference/proposals/csharp-14.0/extensions):

```csharp
extension(IServiceCollection services)
{
    public IServiceCollection AddWorkspacesDomain()
    {
        var assembly = typeof(ServiceCollectionExtensions).Assembly;

        services.AddValidatorsFromAssembly(assembly, includeInternalTypes: true);
        services.AddBlouppyEvents(options => options.RegisterServicesFromAssemblies(assembly));
        services.AddIntegrationEventHandlers(assembly);

        services
            .AddScoped<IWorkspacesService, WorkspacesService>()
            .AddScoped<ITeamsService, TeamsService>()
            .AddScoped<IWorkspacesPublicDataService, WorkspacesPublicDataService>();

        return services;
    }
}
```

The Web calls them all from two methods: `AddDomainServices()` chains `AddNotificationsDomain()`, `AddOrganizationsDomain()`, `AddUsersDomain()`, `AddWorkspacesDomain()` and the modules; `AddInfrastructureServices()` chains the adapters, from `AddFileStorageServices(configuration, environment)` to `AddBlouppyMessaging<BlouppyDbContext>(...)`.

- [`AddValidatorsFromAssembly`](https://docs.fluentvalidation.net/en/latest/di.html) and the two event scans read the assembly they are given, so each domain registers itself. A domain that forgets still compiles, and silently stops validating or handling its events.
- `AddBlouppyMessaging<BlouppyDbContext>` hands the context to the messaging adapter for its outbox, so that adapter never references the database project.

[Architecture tests](https://www.blouppy.com/blog/2026-07-03-architecture-tests-that-fail-the-build/) read the compiled assemblies and fail the build when a reference points the wrong way.


## What it costs
This design is not free:
- **More projects.** A domain is up to four projects plus its tests; the solution has more than a hundred.
- **Ceremony for small features.** A new field on screen can touch the model, the EF configuration, the write input, the read projection, the DTO and the Angular model.
- **Copies on purpose and a vocabulary to learn**: `.PublicData` DTOs, driving and driven ports.

Some of it can be relaxed: a domain no peer consults needs no `.PublicData` (Notifications has none). The dependency rule should not be: if it is in the way, change it deliberately, because routing around it is how boundaries erode.


## Conclusion
Hexagonal architecture keeps Clean Architecture's dependency rule and changes where we cut: each domain gets a driving port for the Web, a small contract for its peers and driven ports for everything technical. In front of new code, ask "whose rule is this, and is it a port or an adapter?". The answer names the project, and the compiler keeps the code there. The back end of [Blouppy Starter](https://starter.blouppy.com/) is built this way, with Workspaces as the example domain.


## References

- [Hexagonal architecture](https://alistair.cockburn.us/hexagonal-architecture/) — Alistair Cockburn's original description of ports and adapters.
- [Common web application architectures](https://learn.microsoft.com/dotnet/architecture/modern-web-apps-azure/common-web-application-architectures) — Microsoft Learn: Clean Architecture and the dependency rule in ASP.NET Core.
- [Resource-based authorization in ASP.NET Core](https://learn.microsoft.com/aspnet/core/security/authorization/resourcebased) — Microsoft Learn: the `IAuthorizationService` check the controller makes.
- [Extension members](https://learn.microsoft.com/dotnet/csharp/language-reference/proposals/csharp-14.0/extensions) — the C# 14 `extension` blocks used for registration.
- [FluentValidation: dependency injection](https://docs.fluentvalidation.net/en/latest/di.html) — `AddValidatorsFromAssembly` and internal validators.
- [AWS SDK for .NET](https://docs.aws.amazon.com/sdk-for-net/v3/developer-guide/welcome.html) — the SDK behind the S3 adapter.
- [Hexagonal architecture in Blouppy Starter](https://docs.starter.blouppy.com/choices/hexagonal/) — the Starter's documentation of the choice and its cost.
- [Domains and modules](https://docs.starter.blouppy.com/architecture/domains-and-modules/) — the Starter's project layout per domain.
