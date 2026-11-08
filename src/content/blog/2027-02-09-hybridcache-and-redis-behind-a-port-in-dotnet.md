---
templateKey: 'blog-post'
title: 'HybridCache and Redis behind a port in .NET'
date: 2027-02-09T09:00:00.000Z
author: Jimmy Boinembalome
authorimage: /img/jimmy.jpg
category: C#
topic: 'C# & .NET'
illustration: 1
categorycolor: bg-purple-100 text-purple-800
featuredpost: true
description: >-
  Learn how HybridCache combines an in-memory cache with Redis in .NET 10, with tags, expirations and stampede protection, and how to hide it behind a small port that survives a Redis outage.
tags:
  - Development
  - C#
  - ASP.NET Core
  - Redis
---

Caching in .NET used to mean choosing between two interfaces. `IMemoryCache` is fast but lives in one process, so two replicas disagree. `IDistributedCache` is shared but deals in bytes, has no in-memory copy and no way to drop a group of entries at once. Most teams end up writing the same glue on top of the second one: serialize, deserialize, prefix the keys, hope nobody forgets to remove the right ones.

`HybridCache` is that glue, shipped by Microsoft: an in-process cache (L1) in front of a distributed one (L2, Redis here), tags, per-entry expirations and protection against a stampede of identical requests. In this article, we will look at what it does on its own, then put it behind a port the way [Blouppy Starter](https://starter.blouppy.com/) does: why a port at all, how writes invalidate, how keys keep tenants apart, how values are serialized, and what happens when Redis goes away.

The authorization side of caching authenticated responses (replaying the policy before a hit, `no-store` by default, output caching for anonymous data) is covered in [caching authenticated API responses without leaking data](/blog/2026-07-27-caching-authenticated-api-responses-in-aspnet-core/). Here we stay on the cache itself.


## HybridCache on its own
The package is `Microsoft.Extensions.Caching.Hybrid` (the Starter pins `10.11.0` in `Directory.Packages.props`). Registration is one call, and the L2 is whatever out-of-process `IDistributedCache` is in the container:

```csharp
builder.Services.AddHybridCache(options =>
{
    options.MaximumPayloadBytes = 1024 * 1024;
    options.DefaultEntryOptions = new HybridCacheEntryOptions
    {
        Expiration = TimeSpan.FromMinutes(5),
        LocalCacheExpiration = TimeSpan.FromMinutes(1)
    };
});

builder.Services.AddStackExchangeRedisCache(options =>
    options.Configuration = builder.Configuration.GetConnectionString("cache"));
```

The main method is `GetOrCreateAsync`: look in L1, then in L2, and only then call the factory and store its result in both.

```csharp
public sealed class PlanReader(HybridCache cache, IPlanRepository plans)
{
    public async Task<PlanSummary> GetAsync(int organizationId, CancellationToken cancellationToken)
        => await cache.GetOrCreateAsync(
            $"org:{organizationId}:plan",
            async cancel => await plans.GetSummaryAsync(organizationId, cancel),
            new HybridCacheEntryOptions { Expiration = TimeSpan.FromSeconds(60) },
            [$"organization:{organizationId}"],
            cancellationToken);

    public Task InvalidateAsync(int organizationId, CancellationToken cancellationToken)
        => cache.RemoveByTagAsync($"organization:{organizationId}", cancellationToken).AsTask();
}
```

A few behaviours matter more than the signature:

- **Stampede protection.** For a given key, only one concurrent caller runs the factory; the others on the same `HybridCache` instance wait for its result. The coordination is per instance: three replicas can still run the factory three times.
- **Two expirations.** `Expiration` is the lifetime of the entry; `LocalCacheExpiration` is how long the in-process copy lives. A shorter local lifetime is the knob that bounds how long one replica can disagree with Redis.
- **Tags are logical.** `RemoveByTagAsync` deletes nothing. It records "ignore anything with this tag created before now", and a later read treats an older entry as a miss. The values stay in memory and in Redis until they expire. `RemoveByTagAsync("*")` invalidates everything, and glob patterns such as `"org*"` are not supported.
- **Other replicas' L1 is not touched.** The documentation is explicit: an invalidation reaches the current server and the distributed store, not the in-memory cache of the other servers. Their copies live until `LocalCacheExpiration`.
- **Serialization.** `string` and `byte[]` are handled natively, everything else goes through `System.Text.Json`, and `AddSerializer<T, TSerializer>()` or `AddSerializerFactory<T>()` replace it. Payloads above `MaximumPayloadBytes` (1 MB by default) and keys longer than `MaximumKeyLength` (1024 characters) are logged and not cached.
- **Flags.** `HybridCacheEntryFlags` switches parts off per call: `DisableLocalCache`, `DisableDistributedCache`, `DisableUnderlyingData` (never call the factory), `DisableCompression`, and their read-only or write-only variants.

Without any `IDistributedCache` registered, `HybridCache` still works as an in-process cache with stampede protection. An `AddDistributedMemoryCache()` registration is ignored as an L2, since it would only duplicate L1.


## Why a port in front of it
`HybridCache` is already an abstract class, so wrapping it can look like ceremony. The Starter does it for three reasons, all visible in [hexagonal architecture](/blog/2026-05-04-hexagonal-architecture-in-dotnet/) terms:

- **The caller speaks its own vocabulary.** It asks for a response for a subject, under a scope. It never builds a raw string key or a raw tag, so it cannot get either wrong.
- **The failure policy lives in one place.** A cache is an optimization, never a dependency; that rule is written once in the adapter instead of in a `try` at every call site.
- **The library stays replaceable.** Only `Blouppy.Infrastructure.Caching` references `Microsoft.Extensions.Caching.Hybrid`.

The port, in `Blouppy.Infrastructure.Caching.Abstractions`, is three methods:

```csharp
namespace Blouppy.Infrastructure.Caching.Abstractions;

public interface IResponseCache
{
    Task<string?> TryGetAsync(ResponseCacheKey key, CancellationToken cancellationToken = default);

    Task SetAsync(
        ResponseCacheKey key,
        CacheScope scope,
        string payload,
        CancellationToken cancellationToken = default);

    Task InvalidateAsync(CacheScope scope, CancellationToken cancellationToken = default);
}
```

Two choices stand out. The payload is a `string`, the rendered body, so the cache never needs to know a type and `HybridCache` stores it without its JSON serializer. And there is no `GetOrCreateAsync`: reading and writing are separate, which we will pay for below.


## Keys that cannot cross tenants
The key type has a private constructor and a single factory, and that factory needs a `UserId`:

```csharp
public sealed record ResponseCacheKey
{
    private ResponseCacheKey(string value)
        => Value = value;

    public string Value { get; }

    public static ResponseCacheKey ForUser(UserId userId, string requestSignature)
        => new($"u:{userId.Value}:r:{Fingerprint(requestSignature)}");

    private static string Fingerprint(string value)
        => Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(value)));
}
```

A key shared between two users cannot be written at all. Hashing the request signature has two side effects worth having: the key length is fixed (always far below the 1024-character limit), and raw user input such as a query string never reaches Redis as a key.

The tag is the other half. `CacheScope` is written `kind:value`, and the kind comes from the id's type:

```csharp
public sealed record CacheScope
{
    public static CacheScope For<TId>(TId id)
        where TId : IntStrongType
        => new(KindOf<TId>.Value, id.Value.ToString(CultureInfo.InvariantCulture));

    public override string ToString()
        => $"{Kind}:{Value}";
}
```

`CacheScope.For(new OrganizationId(12))` is `organization:12`, `CacheScope.For(new WorkspaceId(7))` is `workspace:7`. Since the kind is derived from the type, a scope cannot say "workspace" while carrying an organization id. The key is per user, the tag is per tenant: one invalidation drops the entries of every member of that organization at once.


## The adapter
`HybridResponseCache` implements the port. Here is the read, which is the least obvious part:

```csharp
internal sealed class HybridResponseCache(
    HybridCache cache,
    IOptions<ResponseCacheOptions> options,
    ILogger<HybridResponseCache> logger) : IResponseCache
{
    // Makes the factory unreachable, which is what turns GetOrCreate into a plain read.
    private static readonly HybridCacheEntryOptions ProbeOptions = new()
    {
        Flags = HybridCacheEntryFlags.DisableUnderlyingData
    };

    public async Task<string?> TryGetAsync(ResponseCacheKey key, CancellationToken cancellationToken = default)
    {
        if (!options.Value.Enabled)
        {
            return null;
        }

        try
        {
            return await cache.GetOrCreateAsync<string?>(
                key.Value,
                static _ => ValueTask.FromResult<string?>(null),
                ProbeOptions,
                cancellationToken: cancellationToken);
        }
        catch (Exception exception) when (exception is not OperationCanceledException)
        {
            logger.LogWarning(exception, "Response cache unavailable; reading through to the source");

            return null;
        }
    }
}
```

`HybridCache` has no `TryGet`, so the adapter asks `GetOrCreateAsync` with `DisableUnderlyingData`: the factory is never called, and a miss returns `null`. `SetAsync` calls `cache.SetAsync` with the scope as the only tag, and `InvalidateAsync` is `RemoveByTagAsync(scope.ToString())`. Both catch and log, and a failed invalidation is logged as an error because it is the one failure with a visible effect: stale entries until they expire.

The lifetimes come from `ResponseCacheOptions`: `Duration` is 60 seconds and `LocalDuration` 15 seconds. The short `Duration` is the backstop behind every other argument (a failed invalidation, a write path nobody wired, a Redis blip). The shorter `LocalDuration` bounds what the documentation warns about: after an invalidation on replica A, replica B can serve its in-memory copy for at most 15 seconds.


## Invalidation after the write
Writes declare the scope they dirty. In the Starter, saving an organization's settings, renaming it and deleting it each carry an attribute:

```csharp
[HttpPut(Name = RouteNames.Api.Organizations.Settings.Update)]
[InvalidatesCache<OrganizationId>]
public async Task<ActionResult<OrganizationSettingsDto>> UpdateAsync(
    int organizationId,
    OrganizationSettingsEditionDto organizationSettingsEditionDto,
    CancellationToken cancellationToken)
```

The filter behind it calls `InvalidateAsync` **after** the action has returned a 2xx, so after its commit, with `CancellationToken.None` because the write has already happened and a client that disconnects must not leave the cache stale. The previous article walks through that filter in detail.

The first reader of that tag is not a controller. `ApiAndMcpAccessGuard` decides whether a personal access token may use the API in an organization, which means reading the organization's settings on every token request:

```csharp
var key = ResponseCacheKey.ForUser(
    userId,
    string.Create(CultureInfo.InvariantCulture, $"organization-settings:{organizationId.Value}:api-and-mcp-access"));

if (await responseCache.TryGetAsync(key, cancellationToken) is { } cached
    && Enum.TryParse<ApiAndMcpAccessLevel>(cached, out var cachedLevel))
{
    return cachedLevel;
}

var organizationSettings = await organizationSettingsApiQueryService.GetAsync(organizationId, cancellationToken);

// Scoped by the organization, so saving its settings drops the entry for every user at once.
await responseCache.SetAsync(
    key,
    CacheScope.For(organizationId),
    organizationSettings.ApiAndMcpAccess.ToString(),
    cancellationToken);
```

The value is an enum stored as its name, and a value that no longer parses is treated as a miss. In a project-management app built on the Starter, the same port caches a workspace's labels per member with `[CachedResponse<WorkspaceId>(Policies.Read)]`, and the three label writes carry `[InvalidatesCache<WorkspaceId>]`.


## When Redis is down
The registration decides most of it:

```csharp
public IHostApplicationBuilder AddResponseCacheStore()
{
    var connectionString = builder.Configuration.GetConnectionString(CacheConnectionName);

    builder.Services.AddHybridCache();

    if (!string.IsNullOrWhiteSpace(connectionString))
    {
        // No health check: a Redis outage must not take the API out of its load balancer's rotation.
        builder.AddRedisDistributedCache(CacheConnectionName, settings => settings.DisableHealthChecks = true);

        return builder;
    }

    builder.Services.PostConfigure<ResponseCacheOptions>(options => options.Enabled = false);

    if (!builder.Environment.IsDevelopment())
    {
        builder.Services.AddHostedService<ResponseCacheDisabledWarning>();
    }

    return builder;
}
```

- **Redis configured but unreachable**: every call is caught in the adapter, logged, and the request reads from the database. The health check is disabled on purpose, so `/health` stays green.
- **No connection string at all**: the cache is switched off entirely. An L1-only cache would be tempting, but an in-memory cache per replica would look fine on one instance and serve stale data on two, since an invalidation cannot reach the other replicas' memory. Outside Development, a hosted service logs a warning at startup saying every read goes to the database.

The Aspire AppHost starts Redis without a data volume: after a restart, a cold cache only makes the first requests slower.


## The costs and the pitfalls
The port is not free:

- **No stampede protection.** Splitting `TryGetAsync` and `SetAsync` means the factory runs outside `HybridCache`, so a hundred concurrent misses on one key do a hundred reads. The Starter accepts it because the filter must replay authorization before a hit and store only a `200`, which a factory cannot express. A cache for expensive, subject-free data should call `GetOrCreateAsync` directly.
- **Invalidation only where it is declared.** A write from a message consumer, a seeder or an `ExecuteUpdate` does not go through the attribute. The 60-second expiry bounds the damage.
- **Coarse tags.** One write drops the whole organization's entries. That costs some misses and buys the guarantee that no route was forgotten.
- **Size limits are silent to the caller.** A body over 1 MB is logged and not stored: the endpoint just never hits.


## Choosing the simpler tool
It depends on the data:

- **One process, data nobody else writes**: `IMemoryCache` is enough. `HybridCache` without an L2 is a reasonable upgrade for its stampede protection.
- **Several replicas, a value you already serialize**: `IDistributedCache` works, but `HybridCache` gives an L1, tags and serialization for the same Redis.
- **Anonymous responses, identical for everyone**: [output caching](https://learn.microsoft.com/aspnet/core/performance/caching/output) stores the whole HTTP response, has its own tags and `EvictByTagAsync`, and needs no port. The Starter uses it for the public plan catalog only.
- **Per-user, per-tenant data with authorization in the action**: a port over `HybridCache`, with keys that require a subject and tags that name the tenant.

If the database answers in a few milliseconds and the load is modest, the honest answer is no cache at all. Every cached read is one more place where data can be stale.


## Conclusion
`HybridCache` gives .NET 10 a two-level cache with tags, two expirations and stampede protection, as long as we remember that tag removal is logical and that other replicas' memory is only bounded by `LocalCacheExpiration`. Behind a three-method port, the keys require a user, the tags name the tenant, invalidation runs after the commit, and Redis becomes an optimization the API can lose without failing.

This is how the response cache is built in [Blouppy Starter](https://starter.blouppy.com/).


## References
- [HybridCache library in ASP.NET Core](https://learn.microsoft.com/aspnet/core/performance/caching/hybrid) — registration, tags, options, serialization and the multi-server caveat.
- [`HybridCacheEntryFlags`](https://learn.microsoft.com/dotnet/api/microsoft.extensions.caching.hybrid.hybridcacheentryflags) — the per-call flags, including `DisableUnderlyingData`.
- [`HybridCacheOptions`](https://learn.microsoft.com/dotnet/api/microsoft.extensions.caching.hybrid.hybridcacheoptions) — payload and key limits, default entry options.
- [Distributed caching in ASP.NET Core](https://learn.microsoft.com/aspnet/core/performance/caching/distributed) — `IDistributedCache` and its Redis implementation.
- [Cache in-memory in ASP.NET Core](https://learn.microsoft.com/aspnet/core/performance/caching/memory) — `IMemoryCache`.
- [Output caching middleware](https://learn.microsoft.com/aspnet/core/performance/caching/output) — whole-response caching with policies and tags.
- [Aspire Redis distributed caching integration](https://learn.microsoft.com/dotnet/aspire/caching/stackexchange-redis-distributed-caching-integration) — `AddRedisDistributedCache` and its settings.
