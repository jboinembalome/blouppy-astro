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

Caching in .NET used to mean choosing between two interfaces. `IMemoryCache` is fast but lives in one process, so two replicas disagree. `IDistributedCache` is shared but deals in bytes, keeps no in-memory copy and cannot drop a group of entries at once. Most teams wrote the same glue on top of the second one.

`HybridCache` is that glue, shipped by Microsoft: an in-process cache (L1) in front of a distributed one (L2, Redis here), with tags, two expirations and protection against a stampede of identical requests.


## HybridCache on its own
The package is `Microsoft.Extensions.Caching.Hybrid`. The L2 is whatever out-of-process `IDistributedCache` the container holds. Here is a plan summary cached per organization:

```csharp
builder.Services.AddHybridCache(options => options.DefaultEntryOptions = new HybridCacheEntryOptions
{
    Expiration = TimeSpan.FromMinutes(5),
    LocalCacheExpiration = TimeSpan.FromMinutes(1)
});

builder.Services.AddStackExchangeRedisCache(options =>
    options.Configuration = builder.Configuration.GetConnectionString("cache"));

public sealed class PlanReader(HybridCache cache, IPlanRepository plans)
{
    public async Task<PlanSummary> GetAsync(int organizationId, CancellationToken cancellationToken)
        => await cache.GetOrCreateAsync(
            $"org:{organizationId}:plan",
            async cancel => await plans.GetSummaryAsync(organizationId, cancel),
            tags: [$"organization:{organizationId}"],
            cancellationToken: cancellationToken);

    public Task InvalidateAsync(int organizationId, CancellationToken cancellationToken)
        => cache.RemoveByTagAsync($"organization:{organizationId}", cancellationToken).AsTask();
}
```

`GetOrCreateAsync` looks in L1, then in L2, and only then calls the factory and stores its result in both. A few behaviours matter more than the signature.

**Stampede protection is per instance.** For a given key, only one concurrent caller runs the factory, and the others wait for its result. Three replicas can still run it three times.

**There are two expirations.** `Expiration` is the lifetime of the entry. `LocalCacheExpiration` is how long the in-process copy lives.

**Tags are logical.** `RemoveByTagAsync` deletes nothing. It records "ignore anything with this tag created before now", and a later read treats an older entry as a miss.

**Other servers' memory is not touched.** The documentation is explicit: a tag invalidation reaches Redis and the in-memory cache of the current server. The in-memory copies of the other servers live until their `LocalCacheExpiration`. So the local lifetime is the knob that bounds how long a replica can serve stale data.

The rest is details: `string` and `byte[]` are stored as is, anything else goes through `System.Text.Json`, and a payload above 1 MB is logged and not cached.


## Why a port in front of it
`HybridCache` is already an abstract class, so wrapping it can look like ceremony. [Blouppy Starter](https://starter.blouppy.com/) does it anyway, for three reasons. The caller speaks its own vocabulary and never builds a raw key or tag. The failure policy, "a cache is an optimization, never a dependency", is written once. And only one adapter project references the library ([hexagonal architecture](/blog/2026-05-04-hexagonal-architecture-in-dotnet/)).

The port is three methods:

```csharp
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

The payload is a `string`, the rendered body, so no serializer is involved. The key type has a private constructor and one factory, `ResponseCacheKey.ForUser(userId, requestSignature)`. A key shared between two users cannot be written at all. The signature is hashed with SHA-256, so the key has a fixed length and raw query strings never reach Redis.

The tag is the other half. `CacheScope.For(new OrganizationId(12))` is `organization:12`, and the kind is derived from the id's type, so a scope cannot say "workspace" while carrying an organization id. The key is per user, the tag is per tenant: one invalidation drops the entries of every member at once.

There is no `GetOrCreateAsync`, on purpose. The response cache's filter must replay authorization before a hit and store only a `200`, which a factory cannot express ([caching authenticated API responses](/blog/2026-07-27-caching-authenticated-api-responses-in-aspnet-core/) covers that side). The price is the stampede protection: a hundred concurrent misses on one key do a hundred reads.


## A read that never calls the factory
`HybridCache` has no `TryGet`. The adapter asks `GetOrCreateAsync` with a flag that makes the factory unreachable. This is trimmed of the switch that turns the cache off:

```csharp
private static readonly HybridCacheEntryOptions ProbeOptions = new()
{
    Flags = HybridCacheEntryFlags.DisableUnderlyingData
};

public async Task<string?> TryGetAsync(ResponseCacheKey key, CancellationToken cancellationToken = default)
{
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
```

A miss returns `null`. A Redis failure returns `null` too, and the request reads from the database. `SetAsync` and `InvalidateAsync` catch and log the same way. A failed invalidation is logged as an error, because it is the one failure with a visible effect.

The lifetimes are short: 60 seconds in Redis, 15 seconds in memory. The 60 seconds are the backstop behind every gap: a failed invalidation, a write path that declares nothing, a Redis blip. The 15 seconds bound the multi-server caveat above: after an invalidation on replica A, replica B serves its own copy for at most that long.

Writes declare what they dirty. Saving an organization's settings carries `[InvalidatesCache<OrganizationId>]`, and the filter behind it invalidates after the action returns a 2xx, so after the commit.


## When Redis is not there
The registration turns off Aspire's Redis health check, so an outage does not take the API out of its load balancer's rotation. With no connection string at all, the cache is switched off entirely, and outside Development a warning says so at startup.

An L1-only cache would be tempting there. It would look fine on one instance and serve stale data on two, since an invalidation cannot reach the other replicas' memory.

The simpler tools still have their place. In one process with data nobody else writes, `IMemoryCache` is enough. For anonymous responses identical for everyone, [output caching](https://learn.microsoft.com/aspnet/core/performance/caching/output) needs no port. And if the database answers in a few milliseconds, the honest answer is no cache at all: every cached read is one more place where data can be stale.


## References
- [HybridCache library in ASP.NET Core](https://learn.microsoft.com/aspnet/core/performance/caching/hybrid) — registration, tags, serialization and the multi-server caveat.
- [`HybridCacheEntryFlags`](https://learn.microsoft.com/dotnet/api/microsoft.extensions.caching.hybrid.hybridcacheentryflags) — the per-call flags, including `DisableUnderlyingData`.
- [Distributed caching in ASP.NET Core](https://learn.microsoft.com/aspnet/core/performance/caching/distributed) — `IDistributedCache` and its Redis implementation.
- [Aspire Redis distributed caching integration](https://learn.microsoft.com/dotnet/aspire/caching/stackexchange-redis-distributed-caching-integration) — `AddRedisDistributedCache` and its settings.
