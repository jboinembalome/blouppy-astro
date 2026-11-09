---
templateKey: 'blog-post'
title: 'Scoped, transient, singleton: DI lifetimes in .NET and the captive dependency'
date: 2026-05-07T09:00:00.000Z
author: Jimmy Boinembalome
authorimage: /img/jimmy.jpg
category: C#
topic: 'C# & .NET'
illustration: 1
categorycolor: bg-purple-100 text-purple-800
featuredpost: true
description: >-
  Learn what transient, scoped and singleton mean in .NET, how a singleton captures a DbContext, how scope validation catches it, and how to open a scope in a consumer or a job.
tags:
  - Development
  - C#
  - ASP.NET Core
  - Dependency Injection
---

Every registration in a .NET application picks a lifetime: `AddTransient`, `AddScoped` or `AddSingleton`. Most of the time the choice looks harmless. Then a background job reads stale data, or a `DbContext` throws because two threads use it at once. The cause is often the same: a service lives longer than one of its dependencies was meant to.


## Three lifetimes
The built-in container knows three lifetimes:

- **Transient**: a new instance on every resolution.
- **Scoped**: one instance per scope. Everything resolved from the same scope shares it.
- **Singleton**: one instance for the life of the application.

The choice follows from the state a service holds. A service with no state can be a singleton. A service that holds a unit of work must be scoped. `AddDbContext` registers an EF Core context as scoped by default, because a context tracks entities and is not thread safe. In [Blouppy Starter](https://starter.blouppy.com/), every repository and the unit of work are scoped, so they share the one `DbContext` of the scope and save two aggregates in one transaction.

In ASP.NET Core, a scope is a request. The framework opens one when the request starts and disposes it when the response is sent. That is why "scoped" feels like "per request": the framework did the work.


## The captive dependency
A captive dependency is a service held by another that lives longer. The classic case is a singleton that takes a scoped service in its constructor:

```csharp
public sealed class PriceCache(AppDbContext dbContext) : IPriceCache
{
    public Task<decimal?> GetAsync(int productId, CancellationToken cancellationToken)
        => dbContext.Prices
            .Where(x => x.ProductId == productId)
            .Select(x => (decimal?)x.Amount)
            .SingleOrDefaultAsync(cancellationToken);
}

services.AddDbContext<AppDbContext>(...);
services.AddSingleton<IPriceCache, PriceCache>();
```

The singleton is built once, with the context of the first scope that resolved it. From then on, every request shares that context. Its change tracker keeps growing and returns stale entities. Two concurrent requests make EF Core throw, because a second operation started before the first completed. And once that first scope is disposed, the next call throws `ObjectDisposedException`.

The same happens with less obvious services. `IOptionsSnapshot<T>` is scoped, so a singleton that injects it keeps the snapshot of its first request; a singleton reads `IOptionsMonitor<T>` instead. A transient injected into a singleton also lives as long as the singleton.

The rule: **a service may depend only on services that live as long or longer**. A transient may take anything. A scoped service may take scoped services and singletons. A singleton may take only singletons.


## Opening a scope yourself
Outside a request, nobody opens a scope unless a library does it. A hosted service, a message consumer or a scheduled job starts on the root provider. Each has to answer one question: **who opens the scope, and when does it end?**

Some libraries answer it for you. Quartz.NET resolves each job from a new scope on every run, so a job can take scoped services in its constructor. The Starter's messaging adapter opens one scope per delivery: one message, one scope, one `DbContext`.

A `BackgroundService` gets no such help: it is a singleton that runs for the life of the host. The Starter's identity host prunes OpenIddict's tokens every hour in one. Simplified, it looks like this:

```csharp
internal sealed class TokenPruning(IServiceScopeFactory scopeFactory) : BackgroundService
{
    public async Task PruneAsync(CancellationToken cancellationToken)
    {
        await using var scope = scopeFactory.CreateAsyncScope();

        var tokenManager = scope.ServiceProvider.GetRequiredService<IOpenIddictTokenManager>();

        await tokenManager.PruneAsync(DateTimeOffset.UtcNow - TokenRetention, cancellationToken);
    }
}
```

It injects `IServiceScopeFactory`, which is a singleton, and keeps nothing scoped in a field. The same shape fixes `PriceCache` above: inject the scope factory and open a scope around the read.

Prefer `CreateAsyncScope()` with `await using` over `CreateScope()`. A `DbContext` implements `IAsyncDisposable`, and a scope disposed synchronously throws when it holds a service that only implements `IAsyncDisposable`.


## Let the container check
Two options of the container catch most of these mistakes:

- **`ValidateScopes`** throws when a singleton depends on a scoped service, and when a scoped service is resolved from the root provider.
- **`ValidateOnBuild`** checks every registration when the provider is built. A missing dependency, or a captive one, then fails at startup instead of on the first request.

The default host turns both on **in Development only**. The same broken registration starts fine in Staging and Production. To check it everywhere, set them yourself:

```csharp
builder.Host.UseDefaultServiceProvider(options =>
{
    options.ValidateScopes = true;
    options.ValidateOnBuild = true;
});
```

Both have limits. `ValidateOnBuild` cannot see inside a factory registration such as `services.AddTransient<IClient>(provider => ...)`: what the lambda resolves is only known when it runs. In the Starter, CI runs with `ASPNETCORE_ENVIRONMENT=CI`, so the host does not validate there. Some test suites build their provider with both options on to check their registrations explicitly.


## Two traps validation misses
**Disposable transients at the root.** The container keeps a reference to every disposable transient until the scope that resolved it ends, so it can dispose it. Inside a request, that is fine. Resolved from the root provider, the scope never ends: a singleton that resolves a disposable transient in a loop leaks until shutdown, and nothing reports it. Open a scope around the work, or create the object with `new` and dispose it yourself.

**State in singletons.** A singleton is shared by every request at once. A `Dictionary<,>` in a singleton field is a bug waiting for load. The Starter's SSO connection lookup, a singleton, caches in a `ConcurrentDictionary` for that reason. Scoped services are safe within one request, until you run `Task.WhenAll` over two queries on the same `DbContext`.

For most applications, the defaults are enough: scoped services, singletons for stateless helpers and caches, validation on. The care is needed at the edges: a singleton that touches data, a background service, a consumer, a job.


## References
- [Dependency injection in .NET](https://learn.microsoft.com/dotnet/core/extensions/dependency-injection) — Microsoft Learn: the container, the three lifetimes and scope validation.
- [Dependency injection guidelines](https://learn.microsoft.com/dotnet/core/extensions/dependency-injection-guidelines) — Microsoft Learn: disposal, captive dependencies and the transient leak at the root.
- [Use scoped services within a BackgroundService](https://learn.microsoft.com/dotnet/core/extensions/scoped-service) — Microsoft Learn: `IServiceScopeFactory` in a hosted service.
- [Hexagonal architecture in .NET](/blog/2026-05-04-hexagonal-architecture-in-dotnet/) — the composition root where these registrations live.
