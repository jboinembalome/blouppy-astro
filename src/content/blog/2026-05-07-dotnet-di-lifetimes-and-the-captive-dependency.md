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

Every registration in a .NET application picks a lifetime: `AddTransient`, `AddScoped` or `AddSingleton`. Most of the time the choice looks harmless, and the application works. Then a background job reads stale data, a `DbContext` throws because two threads use it at once, or memory grows slowly until the process restarts. The cause is often the same: a service lives longer than one of its dependencies was meant to.

In this article, we will look at what each lifetime means, what a scope is inside and outside a request, the captive dependency and how the container catches it, how to open a scope ourselves, and two pitfalls that validation does not catch: disposable transients and shared state in singletons. The examples come from [Blouppy Starter](https://starter.blouppy.com/), the code base behind the [hexagonal architecture](/blog/2026-05-04-hexagonal-architecture-in-dotnet/) article.


## Three lifetimes
The built-in container in `Microsoft.Extensions.DependencyInjection` knows three lifetimes:

- **Transient**: a new instance on every resolution. Two services that both depend on a transient get two instances.
- **Scoped**: one instance per scope. Everything resolved from the same scope shares it.
- **Singleton**: one instance per container, for the life of the application.

```csharp
services.AddTransient<IPriceFormatter, PriceFormatter>();
services.AddScoped<IOrdersRepository, OrdersRepository>();
services.AddSingleton<IClock, SystemClock>();
```

The choice follows from the state a service holds. A service with no state can be a singleton. A service that holds a unit of work, such as an EF Core `DbContext`, must be scoped: `AddDbContext` registers the context as scoped by default, because a context tracks entities and is not thread safe. A transient fits a light object whose state should never be shared, even inside one operation.

The Starter writes its rules down in its `CLAUDE.md`: stateless utilities are singletons, application services and EF Core repositories are scoped, the unit of work is scoped, and message consumers are scoped with "a scope per delivery". The database adapter follows that table line by line:

```csharp
services
    .AddScoped<INotificationsRepository, NotificationsRepository>()
    .AddScoped<INotificationsApiQueryRepository, NotificationsApiQueryRepository>()
    .AddScoped<INotificationPreferencesRepository, NotificationPreferencesRepository>();

services
    .AddScoped<IUnitOfWork, UnitOfWork>();
```

Every repository and the unit of work share the one `BlouppyDbContext` of the scope, which is what lets a service change two aggregates and save them in one transaction.


## What a scope is
In ASP.NET Core, a scope is a request. The framework creates one when the request starts, resolves the controller from it, and disposes it when the response is sent. That is why a scoped service feels like "per request": the framework did the work.

Outside a request, nobody creates a scope for us unless a library does it. A hosted service, a message consumer or a scheduled job runs on the root provider by default, where a scoped service has no scope to belong to. Each of them has to answer the question: **who opens the scope, and when does it end?**

**A message consumer.** The messaging adapter registers each consumer as scoped (`TryAddScoped<TConsumer>()`), and the handler that runs it opens a scope for each delivery:

```csharp
internal sealed class ConsumerMessageHandler<TMessage, TConsumer> : MessageHandler<TMessage>
    where TMessage : class
    where TConsumer : class, IMessageConsumer<TMessage>
{
    protected override async Task HandleAsync(TMessage message, MessageContext context, CancellationToken cancellation)
    {
        await using var scope = context.Runtime.Services.CreateAsyncScope();
        var services = scope.ServiceProvider;

        services.GetRequiredService<ScopedMessageContextHolder>().Context = context;

        await services
            .GetRequiredService<TConsumer>()
            .ConsumeAsync(message, new ConsumedMessage(context.Envelope!.Id), cancellation);
    }
}
```

One delivery, one scope, one `DbContext`.

**A Quartz.NET job.** Quartz.NET's integration with `Microsoft.Extensions.DependencyInjection` resolves a job from a new scope on each run, so a job can take scoped services in its constructor like a controller does:

```csharp
[DisallowConcurrentExecution]
internal sealed class NotificationPurgeJob(INotificationRetentionService notificationRetentionService) : IJob
{
    public static readonly TimeSpan Interval = TimeSpan.FromDays(1);

    public async ValueTask Execute(IJobExecutionContext context, CancellationToken cancellationToken = default)
        => await notificationRetentionService.PurgeExpiredAsync(cancellationToken);
}
```

`INotificationRetentionService` is a scoped domain service. The library opens the scope, and the job never sees it.

**A hosted service.** A `BackgroundService` is a singleton that runs for the life of the host. The identity host prunes OpenIddict's tokens every hour in one, and opens a scope for each run:

```csharp
internal sealed class TokenPruning(
    IServiceScopeFactory scopeFactory,
    TimeProvider timeProvider,
    ILogger<TokenPruning> logger) : BackgroundService
{
    public async Task PruneAsync(CancellationToken cancellationToken = default)
    {
        await using var scope = scopeFactory.CreateAsyncScope();

        var now = timeProvider.GetUtcNow();

        var tokens = await scope.ServiceProvider.GetRequiredService<IOpenIddictTokenManager>()
            .PruneAsync(now - TokenRetention, cancellationToken);
    }
}
```

It injects `IServiceScopeFactory`, a singleton, and keeps nothing scoped in a field.

`CreateAsyncScope()` returns an `AsyncServiceScope`, and `await using` disposes it asynchronously. Prefer it over `CreateScope()`: a `DbContext` implements `IAsyncDisposable`, and a scope disposed synchronously throws when it holds a service that only implements `IAsyncDisposable`.


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

The singleton is built once, with the context of whichever scope resolved it first. From then on, every request shares that one context: its change tracker keeps growing, it returns tracked entities that are stale, and two concurrent requests make EF Core throw because a second operation started on the context before the first completed. Once the first scope is disposed, the captured context is disposed too, and the next call throws `ObjectDisposedException`.

The same happens with less obvious services. `IOptionsSnapshot<T>` is registered as scoped, so a singleton that injects it captures the snapshot of its first request; a singleton reads `IOptions<T>` or `IOptionsMonitor<T>` instead. A transient injected into a singleton also lives as long as the singleton.

The rule is simple: **a service may depend on services that live as long or longer**. Transient may take anything, scoped may take scoped and singletons, and a singleton may take only singletons.

The Starter's AI module shows the shape that respects it. `OrganizationLlmClientResolver` is scoped, because it reads the organization's key through a repository. It depends on two singletons: `ILlmClientFactory`, which builds a client from a key, and `OrganizationLlmClients`, a cache of one client per organization. The factory itself only takes singletons:

```csharp
internal sealed class LlmClientFactory(
    IHttpClientFactory httpClientFactory,
    IOptions<LlmOptions> options,
    ILoggerFactory loggerFactory) : ILlmClientFactory
{
    public ILlmClient Create(
        string provider,
        string apiKey)
    {
        return new AnthropicLlmClient(
            httpClientFactory,
            options.Value.Anthropic,
            apiKey,
            loggerFactory.CreateLogger<AnthropicLlmClient>());
    }
}
```

The scoped part reads per request; the long-lived parts hold no scoped service. When a singleton does need the database, it does what `SsoConnectionLookup` does in the identity host: inject `IServiceScopeFactory` and open a scope around the read, as `TokenPruning` does above.


## ValidateScopes and ValidateOnBuild
The container can catch a captive dependency, through two options of `ServiceProviderOptions`:

- **`ValidateScopes`** throws when a singleton depends on a scoped service (`Cannot consume scoped service ... from singleton ...`), and when a scoped service is resolved from the root provider.
- **`ValidateOnBuild`** checks every registration when the provider is built, so a missing dependency fails at startup instead of on the first request that needs it. With `ValidateScopes` also on, a captive dependency fails at startup too.

The default host turns both on **in the Development environment only**. `WebApplication.CreateBuilder` and `Host.CreateApplicationBuilder` set them from `IsDevelopment()`, so the same broken registration starts fine in Staging and Production. To check it everywhere, set them ourselves:

```csharp
builder.Host.UseDefaultServiceProvider(options =>
{
    options.ValidateScopes = true;
    options.ValidateOnBuild = true;
});
```

Both have limits. `ValidateOnBuild` cannot see inside a factory registration such as `services.AddTransient<ILlmClient>(provider => ...)`: what the lambda resolves is only known when it runs. And outside Development, the default host checks nothing at all. In the Starter, CI runs with `ASPNETCORE_ENVIRONMENT=CI`, so the host does not validate there; some test suites build their provider with `new ServiceProviderOptions { ValidateOnBuild = true, ValidateScopes = true }` to check their registrations explicitly.


## Disposable transients
The container disposes what it creates. For a scoped service, that happens when the scope ends. For a transient that implements `IDisposable` or `IAsyncDisposable`, the container also keeps a reference to it **until the scope that resolved it ends**, so that it can dispose it then.

Inside a request, this is fine. In the Starter, `AnthropicLlmClient` is a disposable transient, resolved through `ILlmClient` by the scoped AI gateway: each request gets its client, and the request's scope disposes it.

The trap is a transient resolved from the root provider: the container holds every instance until the application shuts down. A singleton that calls `serviceProvider.GetRequiredService<SomeDisposableTransient>()` in a loop leaks exactly this way, and no validation reports it. Either open a scope around the work, or create the object ourselves through a factory and dispose it ourselves. Objects created with `new`, like the clients `LlmClientFactory` returns, are never tracked by the container, so their owner decides when they go: `OrganizationLlmClients` keeps them in a bounded `MemoryCache` with a sliding expiration.


## Singletons and thread safety
A singleton is shared by every request at once, so its state must be safe under concurrent access. A `Dictionary<,>` in a singleton field is a bug waiting for load. `SsoConnectionLookup` keeps its cache in a `ConcurrentDictionary<string, Entry>`, and `OrganizationLlmClients` in a `MemoryCache`, both safe for concurrent use. A singleton with no mutable state at all, like `LlmClientFactory`, has nothing to protect.

Scoped services do not have this problem in a request, since one scope is used by one request. They get it back when we start parallel work inside a scope, such as `Task.WhenAll` over two queries on the same `DbContext`.


## Keyed services
Since .NET 8, a registration can carry a key: `services.AddKeyedSingleton<IStorage, S3Storage>("s3")`, resolved with `[FromKeyedServices("s3")]` on a parameter or `GetRequiredKeyedService<IStorage>("s3")`. Keys do not change lifetimes or the captive rules. The Starter does not use them: it picks one adapter per port from configuration, as `AddLlmClient` does with `NotConfiguredLlmClient`.


## When not to bother
For most applications, the defaults are enough: register services as scoped, register stateless helpers and caches as singletons, and keep validation on in Development. Making everything a singleton for performance rarely pays: resolving a scoped service is cheap next to a database call.

The care is needed at the edges: a singleton that touches data, a background service, a consumer, a job, or a library that resolves our services for us. In each of those, ask who opens the scope, and check what the long-lived object holds.


## Conclusion
A lifetime is a promise about state: per resolution, per scope or per application. ASP.NET Core opens a scope per request; a consumer, a job or a hosted service has to open its own, or rely on a library that does. A singleton must hold only singletons, and when it needs the database it opens a scope with `CreateAsyncScope()` instead of capturing a `DbContext`. `ValidateScopes` and `ValidateOnBuild` catch most mistakes, but only in Development unless we turn them on ourselves.


## References
- [Dependency injection in .NET (Microsoft Learn)](https://learn.microsoft.com/dotnet/core/extensions/dependency-injection) — the container, the three lifetimes and scope validation.
- [Dependency injection guidelines (Microsoft Learn)](https://learn.microsoft.com/dotnet/core/extensions/dependency-injection-guidelines) — disposal of services, captive dependencies and the transient leak at the root.
- [Dependency injection in ASP.NET Core (Microsoft Learn)](https://learn.microsoft.com/aspnet/core/fundamentals/dependency-injection) — the request scope and scope validation in Development.
- [Use scoped services within a BackgroundService (Microsoft Learn)](https://learn.microsoft.com/dotnet/core/extensions/scoped-service) — `IServiceScopeFactory` in a hosted service.
- [DbContext lifetime, configuration and initialization (Microsoft Learn)](https://learn.microsoft.com/ef/core/dbcontext-configuration/) — why a `DbContext` is scoped and not thread safe.
- [Options pattern in .NET (Microsoft Learn)](https://learn.microsoft.com/dotnet/core/extensions/options) — `IOptions<T>`, `IOptionsSnapshot<T>` and `IOptionsMonitor<T>` and their lifetimes.
- [Quartz.NET: Microsoft DI integration](https://www.quartz-scheduler.net/documentation/quartz-3.x/packages/microsoft-di-integration.html) — how Quartz.NET resolves jobs from the container.
- [Hexagonal architecture in .NET](/blog/2026-05-04-hexagonal-architecture-in-dotnet/) — the composition root where these registrations live.
