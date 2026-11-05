---
templateKey: 'blog-post'
title: 'Hexagonal architecture in .NET: going beyond Clean Architecture'
date: 2026-10-01T09:00:00.000Z
author: Jimmy Boinembalome
authorimage: /img/jimmy.jpg
category: C#
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

A few years ago, we built a small ToDoList API in the [Introduction to Clean Architecture](https://www.blouppy.com/blog/2023-05-28-introduction-to-clean-architecture/): a `Domain` project for the entities, an `Application` project for the use cases and their interfaces, an `Infrastructure` project for the repositories, and an `Api` project on top. For one feature, it is perfect. For many features, something happens: every feature lands in the same `Application` and `Infrastructure` projects, and nothing stops a service from reaching into another feature's repository "just this once". Soon, a change to billing breaks invitations, and nobody can say which code depends on what.

The layers were never the problem. The problem is that they are the *only* boundaries we drew.

In this article, we will take that architecture one step further with **hexagonal architecture** (ports and adapters): one project per domain instead of one `Application` project, driving ports versus driven ports, two kinds of contracts (`.Abstractions` and `.PublicData`), and one composition root that wires everything together.


## A different question
A layered reading asks "**which layer is this in?**". A hexagonal reading asks two other questions:

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

Every reference points inward. The domain never references EF Core, the bus or the mail library: it references the ports, and the adapters reference the ports too.


## One project per domain
In the code base this comes from, each domain is split into up to four projects:

- `Blouppy.Workspaces.Models`: entities, value objects, domain events. It references the `SharedKernel` and nothing else.
- `Blouppy.Workspaces.Abstractions`: the contract **the Web** calls, `IWorkspacesService` and its input records.
- `Blouppy.Workspaces.PublicData`: the contract **other domains** call, with its own DTOs.
- `Blouppy.Workspaces`: the implementation. Services, validators, event handlers, all `internal sealed` except `AddWorkspacesDomain()`.

Let's look at the implementation's project file, because it tells the whole story:

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
- **One** peer, and only through its `.PublicData`: `Blouppy.Organizations` itself is not reachable.
- The two driven ports it uses, the database and the messaging. Not `Blouppy.Infrastructure.Database`, only its `.Abstractions`.

There is no EF Core, no Wolverine and no RabbitMQ here: the compiler does not let the domain see them. 👍 The model itself is plain C#, with its invariants in the constructor:

```csharp
public sealed class Workspace(
    string name,
    Colour colour,
    UserId ownerId,
    OrganizationId organizationId) : AuditableEntityBase<WorkspaceId>
{
    public string Name { get; private set; } = Exceptions.ThrowIfNullOrWhiteSpace(name);
    public Colour Colour { get; private set; } = colour;
    public UserId OwnerId { get; private set; } = Exceptions.ThrowIfNullOrWhiteSpace(ownerId);
    public OrganizationId OrganizationId { get; private set; } = Exceptions.ThrowIfNullOrNegativeOrZero(organizationId);
}
```

Notice that a `Workspace` carries an `OrganizationId`, not an `Organization`. The model never holds another domain's entity.


## Driving ports: the `.Abstractions` project
The driving port is what the Web may ask Workspaces to do. Here is `IWorkspacesService`:

```csharp
namespace Blouppy.Workspaces.Abstractions;

public interface IWorkspacesService
{
    Task<ValidationResult<Workspace>> TryAddAsync(WorkspaceCreation workspaceCreation, CancellationToken cancellationToken = default);
    Task<ValidationResult<Workspace>> TryUpdateAsync(WorkspaceEdition workspaceEdition, CancellationToken cancellationToken = default);
    Task<DeletionResult> TryDeleteAsync(WorkspaceId id, CancellationToken cancellationToken = default);
}
```

Its input records (`WorkspaceCreation`, `WorkspaceEdition`) are declared next to it, and its implementation, `WorkspacesService`, is `internal sealed`. The controller is the driving adapter:

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

- It maps the HTTP DTO to the domain's input record: HTTP shapes never enter the domain.
- It injects a port, never a repository, and commits through `IUnitOfWork` once the use case succeeded.
- Reads go through another port, `IWorkspacesApiQueryService` (separating reads and writes has its own article in this series).


## Driven ports: what the domain needs
A driven port is declared in a `Blouppy.Infrastructure.<Concern>.Abstractions` project, one per adapter. Here is the repository Workspaces needs:

```csharp
namespace Blouppy.Infrastructure.Database.Abstractions.Workspaces;

public interface IWorkspacesRepository
{
    Task<SearchResult<Workspace>> TryGetAsync(WorkspaceId id, CancellationToken cancellationToken = default);
    Task<int> CountByOrganizationAsync(OrganizationId organizationId, CancellationToken cancellationToken = default);
    Task<Workspace> AddAsync(Workspace workspace, CancellationToken cancellationToken = default);
    Workspace Update(Workspace workspace);
    Task DeleteAsync(WorkspaceId id, CancellationToken cancellationToken = default);
}
```

Its adapter, `WorkspacesRepository`, is an `internal sealed` class over `BlouppyDbContext` in `Blouppy.Infrastructure.Database`. A port shows its value best with two adapters behind it. Here is `IFileStorage`, trimmed to its signatures:

```csharp
namespace Blouppy.Infrastructure.FileStorage.Abstractions;

public interface IFileStorage
{
    Task<StoredFile> SaveAsync(FileToStore file, CancellationToken cancellationToken = default);
    Task<SearchResult<Stream>> TryOpenReadAsync(StoragePath path, CancellationToken cancellationToken = default);
    Task DeleteAsync(StoragePath path, CancellationToken cancellationToken = default);
    Task DeleteFolderAsync(string folder, CancellationToken cancellationToken = default);
}
```

Nothing in it says "disk". The Privacy module, which generates the GDPR data export, calls `fileStorage.SaveAsync(new FileToStore(Folder, FileName, Content), ...)` and stores the returned path. Which adapter answers is decided by the adapter's own registration:

```csharp
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
    services
        .AddSingleton<IFileStorage, LocalDiskFileStorage>();
}
```

- `FileStorage:Provider` picks `LocalDiskFileStorage` (the default) or `S3FileStorage` (AWS S3, Cloudflare R2, MinIO...).
- `AWSSDK.S3` is referenced by `Blouppy.Infrastructure.FileStorage` only. The Privacy module references `Blouppy.Infrastructure.FileStorage.Abstractions` and never sees the SDK.

Moving from a disk to a bucket is a configuration change, not a change to any caller. That is the whole promise of ports and adapters, and here it is kept.


## `.PublicData`: the door between domains
Now the interesting part. Workspaces must refuse a new workspace beyond the plan's limit, but the limit belongs to Organizations. In our 2023 layout, the use case would simply have injected the organizations repository. Here, it cannot: `Blouppy.Workspaces` does not reference anything of Organizations except `Blouppy.Organizations.PublicData`.

Let's look at the validator:

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

- A **fact from Organizations**, through `IOrganizationsPublicDataService`.
- A **count from Workspaces**, through its own repository.

`GetEntitlementsAsync` does not return the `OrganizationEntitlements` entity. It returns a record declared in `.PublicData` itself, and Organizations copies the values into it:

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

### Why not just reuse `.Abstractions`?
Because `.Abstractions` carries writes. `IOrganizationMembersService` can remove a member: handing it to a peer would let Workspaces remove someone from an organization. `.PublicData` exposes only what peers legitimately need, and stays small.

### Why a copy instead of the entity?
This one is not cosmetic. Repositories return entities **tracked** by a `DbContext`, that `DbContext` is scoped and shared by every domain within one request, and the unit of work saves the whole context. An entity handed to a peer could be changed there (`entitlements.Update(...)` compiles), and the change would be saved by the next commit, whoever makes it. A copy cannot be.

There is a compiler reason too: project references are transitive. `Blouppy.Organizations.PublicData` references the `SharedKernel` alone, so no path leads from Workspaces to an Organizations entity. Not by rule, by absence.

Workspaces has its own `.PublicData` too, and it is tiny on purpose:

```csharp
public interface IWorkspacesPublicDataService
{
    Task<OrganizationId?> TryGetOrganizationIdAsync(
        WorkspaceId workspaceId,
        CancellationToken cancellationToken = default);
}
```

It holds one fact, because the AI module needed to know which organization pays for a workspace's description. It appeared the day a peer needed it.

> **_Note:_**  `.PublicData` is one of two doors. When the caller needs nothing back, only for something to happen afterwards, it publishes an integration event instead: Workspaces' `RemoveTeamMembershipsWhenOrganizationMemberRemovedIntegrationEventHandler` reacts to Organizations without Organizations knowing it exists. Domain events, integration events and the outbox have their own article in this series. 😉


## The composition root
Somebody has to know everything, and only one project does: `Blouppy.Web`. Each domain exposes one entry point:

```csharp
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
```

And the Web calls them all, domains and adapters, in two methods:

```csharp
// DomainServiceRegistration.AddDomainServices
services
    .AddNotificationsDomain()
    .AddOrganizationsDomain()
    .AddUsersDomain()
    .AddWorkspacesDomain();

// InfrastructureServiceRegistration.AddInfrastructureServices
services
    .AddFileStorageServices(configuration, environment)
    .AddEmailServices(configuration, environment)
    .AddBlouppyMessaging<BlouppyDbContext>(configuration, messaging => { /* ... */ })
    .AddDatabaseServices();
```

- `AddValidatorsFromAssembly`, the domain-event registration and the integration-event scan all bind to the **calling** assembly. That is why each domain must register itself: a single shared registration would only find what lives in its own assembly.
- A domain that forgets its call still compiles, and silently stops validating or handling its events.
- `AddBlouppyMessaging<BlouppyDbContext>` hands the database context to the messaging adapter for its outbox, so that adapter never references the database project.

Finally, these boundaries are not left to code review: architecture tests read the compiled assemblies and fail the build when a reference points the wrong way (a sibling article covers them).


## What it costs
Let's be honest, this is not free:
- **More projects.** A domain is up to four projects plus its tests; the solution has more than a hundred. Builds parallelise, so the cost in time is small, but there is more to navigate.
- **Ceremony for small features.** Adding a field the screen shows may touch the model, the EF configuration, the write input, the read projection, the DTO and the Angular model.
- **Copies on purpose.** `OrganizationEntitlementsPublicDataDto` duplicates properties of an entity, so a peer never holds the entity itself.
- **A vocabulary to learn.** Driving and driven ports, `.Abstractions` versus `.PublicData`, read side versus write side.

Some of it can be relaxed: a domain that no peer consults does not need a `.PublicData` (Notifications has none), and `.Models` and `.Abstractions` can be merged if the Web is the only caller we ever expect. What we should not relax is the dependency rule itself: if a rule is in the way, change it deliberately, because routing around it is exactly how the boundaries erode.


## Conclusion
Clean Architecture gave us the dependency rule: the business logic in the middle, the technology outside. Hexagonal architecture keeps that rule and changes where we cut. Instead of one `Application` project for every feature, each domain gets its own projects, a driving port for the Web (`.Abstractions`), a small contract for its peers (`.PublicData`), and driven ports for everything technical, each with its own adapter project.

The question we ask in front of a new piece of code changes too: not "which layer?", but "whose rule is this, and is this a port or an adapter?". The answer tells us which project it goes in, and the compiler keeps it there. The price is more projects, a bit of ceremony and a few copies made on purpose.

This is how the back end of [Blouppy Starter](https://starter.blouppy.com/) is built, with Workspaces as the complete example domain and modules such as Billing, Privacy and Webhooks taking the same shape. The [hexagonal architecture page](https://docs.starter.blouppy.com/choices/hexagonal/) of its documentation explains the choice and what it costs.

*Thanks for reading! 🙂*
