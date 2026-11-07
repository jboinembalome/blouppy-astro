---
templateKey: 'blog-post'
title: 'Caching authenticated API responses in ASP.NET Core without leaking data'
date: 2026-07-27T09:00:00.000Z
updated: 2026-11-07T09:00:00.000Z
author: Jimmy Boinembalome
authorimage: /img/jimmy.jpg
category: C#
topic: 'Data'
illustration: 2
categorycolor: bg-purple-100 text-purple-800
featuredpost: true
featuredimage: /img/caching-authenticated-api-responses-in-aspnet-core.jpg
description: >-
  Learn how to cache authenticated responses in an ASP.NET Core API without serving one user's data to another, or to a user whose access was revoked.
tags:
  - Development
  - C#
  - ASP.NET Core
  - Security
  - Caching
  - Redis
---

In ASP.NET Core, caching a response is one attribute away. The trouble starts when authorization happens **inside the action**: a cache that answers before the action runs also answers before that check, so user B gets user A's workspace, and a user removed a minute ago keeps reading it.

There is a quieter problem too: a response with **no** `Cache-Control` header is not saying "do not cache me". Under [RFC 9111](https://www.rfc-editor.org/rfc/rfc9111), a cache may store it heuristically, and the browser keeps it for the back button.

In this article, we will build caching for an ASP.NET Core API in three tiers, around one rule: **never key a response by anything less than its subject**.


## The trap, stated precisely
The authorization in a typical action is imperative, because it depends on the resource ([resource-based authorization](https://learn.microsoft.com/aspnet/core/security/authorization/resourcebased)): `if (!await authorizationService.IsAuthorizedAsync(User, new WorkspaceId(id), Policies.Read)) return Forbid();`, where `IsAuthorizedAsync` is a small extension over `AuthorizeAsync(...).Succeeded`. A cache keyed by the **path** serves the first member's response to the next non-member. A cache keyed by **subject + path** does not: a non-member looks up their own key, finds nothing, the action runs, and they get their `403`. What remains is narrower: a user who *was* authorized and has since been revoked keeps reading their own entry until it expires. We will close that too, by replaying the policy before serving a hit.

| Tier | What | Mechanism | Store |
| ---- | ---- | --------- | ----- |
| 0 | everything | `no-store` by default | none |
| 1 | an anonymous catalog | ASP.NET Core output caching | shared, in the API's memory |
| 2 | authenticated lists | a per-caller cache | HybridCache (local + Redis) |


## Tier 0: nothing is cacheable by default
A middleware stamps `no-store` on every API response, **unless the endpoint already set a `Cache-Control`** (trimmed of its guard clause):

```csharp
internal sealed class ApiCacheControlMiddleware(RequestDelegate next)
{
    private const string NoStore = "no-store, no-cache, must-revalidate";

    public Task InvokeAsync(HttpContext context)
    {
        if (!context.Request.Path.StartsWithSegments("/api", StringComparison.OrdinalIgnoreCase))
        {
            return next(context);
        }

        // Deferred, so whatever the endpoint decided has already been written and can be honoured.
        context.Response.OnStarting(
            static state =>
            {
                var response = ((HttpContext)state).Response;

                if (!response.Headers.ContainsKey(HeaderNames.CacheControl))
                {
                    response.Headers.CacheControl = NoStore;
                    response.Headers.Pragma = "no-cache";
                }

                return Task.CompletedTask;
            },
            context);

        return next(context);
    }
}
```

It is a [middleware](https://learn.microsoft.com/aspnet/core/fundamentals/middleware/), not an MVC filter, so it also lands on redirects, 404s and error bodies, and `OnStarting` runs just before the headers are sent, after the endpoint has had its say. "Unless it already has one" is the whole opt-in: an endpoint that says `public, max-age=60` keeps it, and a controller written next year that says nothing is not cacheable. There is no route list to keep in sync.


## Tier 1: one shared response, because there is exactly one
A shared cache is only safe for a response that is the same for every caller, such as an anonymous list of billing plans. [Output caching](https://learn.microsoft.com/aspnet/core/performance/caching/output)'s default policy already skips authenticated requests; the named policy adds a guard that does not depend on it:

```csharp
internal static class ResponseCachePolicies
{
    public const string PublicCatalog = nameof(PublicCatalog);

    public static readonly TimeSpan PublicCatalogDuration = TimeSpan.FromSeconds(60);
    public const string PublicCatalogTag = "billing:catalog";

    public static void AddBlouppyPolicies(this OutputCacheOptions options)
    {
        options.AddPolicy(PublicCatalog, policy => policy
            .Expire(PublicCatalogDuration)
            .Tag(PublicCatalogTag)
            // A shared store must never hold a response produced for somebody in particular,
            // whatever the endpoint's attributes come to say later.
            .With(static context => IsCredentialFree(context.HttpContext.Request)));
    }

    private static bool IsCredentialFree(HttpRequest request)
        => !request.Headers.ContainsKey(HeaderNames.Authorization)
           && !request.Headers.ContainsKey(HeaderNames.Cookie);
}
```

With `.With(...)`, a request carrying an `Authorization` or a `Cookie` header is neither stored nor served from the cache. It checks the **headers** rather than `HttpContext.User`, which do not depend on the middleware's position relative to authentication.

The middleware goes in an unusual place: `app.UseOutputCache()` comes **after** `UseAuthentication()` and `UseAuthorization()`, not right behind `UseRouting()`. Output caching answers a request without running its endpoint, so placed there, a policy added later still cannot bypass the pipeline's own checks.

The action opts in with `[OutputCache(PolicyName = ResponseCachePolicies.PublicCatalog)]`, which keeps a copy on the server, and `[ResponseCache(Duration = 60, Location = ResponseCacheLocation.Any)]`, which writes a `public, max-age=60` header that Tier 0 leaves alone. Nothing evicts the tag yet: the catalog is written at startup only, so the 60-second expiry is the whole invalidation story. The day an admin endpoint edits a plan, it calls `EvictByTagAsync`.


## Tier 2: per caller, keyed by the subject
For anything authenticated, a small port, `IResponseCache` (`TryGetAsync`, `SetAsync`, `InvalidateAsync`), sits in front of [HybridCache](https://learn.microsoft.com/aspnet/core/performance/caching/hybrid). The interesting part is its key (trimmed of its argument guards):

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

The constructor is private and the only factory takes a strongly typed `UserId`: a cross-user entry is **inexpressible**. The request signature is the method, path and query string, taken verbatim: two spellings of one request cost a miss, whereas normalizing away a parameter could return the wrong body.

### The filter that replays the authorization
A cached route declares itself with an attribute, and the action body stays untouched:

```csharp
[HttpGet]
[CachedResponse<WorkspaceId>(Policies.Read)]
public async Task<ActionResult<OffsetPage<CategoryDto>>> GetPageAsync(int workspaceId, ...)
```

Here is the heart of the [action filter](https://learn.microsoft.com/aspnet/core/mvc/controllers/filters) behind it:

```csharp
var scopeId = RouteScope.Resolve<TId>(context.RouteData, routeValueName);
var key = context.HttpContext.Request.ToCacheKey(currentUserService);

if (await authorizationService.IsAuthorizedAsync(context.HttpContext.User, scopeId, policy)
    && await cache.TryGetAsync(key, cancellationToken) is { } cached)
{
    context.Result = new ContentResult
    {
        Content = cached,
        ContentType = "application/json",
        StatusCode = StatusCodes.Status200OK
    };

    return;
}

var executed = await next();

if (executed.Exception is not null
    || executed.Result is not ObjectResult { Value: not null } body
    || body.StatusCode is not (null or StatusCodes.Status200OK))
{
    return;
}

// MVC's own options, so a hit renders identically to a miss — enums as names, not numbers.
var payload = JsonSerializer.Serialize(body.Value, jsonOptions.Value.JsonSerializerOptions);

await cache.SetAsync(key, CacheScope.For(scopeId), payload, cancellationToken);
```

- **The scope comes from the route** parameter named after the id's type (`WorkspaceId` → `{workspaceId}`); a route without it skips the cache.
- **The policy runs before the lookup**, so a revoked user stops being served immediately, not when the entry expires.
- **On a miss**, the action runs with its own check, and only a `200` is stored, never a `403` or an exception.
- **The payload is serialized with MVC's own `JsonSerializerOptions`**: with a `JsonStringEnumConverter` registered, the defaults would make a hit answer `"colour": 3` where a miss answers `"colour": "Red"`.

### A plain read on HybridCache
HybridCache is built around `GetOrCreateAsync`. To get a plain "read, never produce", the adapter passes a factory that returns `null` and makes it unreachable with [`HybridCacheEntryFlags.DisableUnderlyingData`](https://learn.microsoft.com/dotnet/api/microsoft.extensions.caching.hybrid.hybridcacheentryflags). The call is wrapped in a `try`/`catch` that logs and returns `null`: a cache is an optimization, never a dependency. `SetAsync` stores the payload with the scope (for example `workspace:12`) as a **tag**, a 60-second `Expiration` and a 15-second `LocalCacheExpiration` for the in-process copy.


## Invalidation
A write declares which scope it dirties with `[InvalidatesCache<WorkspaceId>]`. Its filter runs **after** the action body:

```csharp
var executed = await next();

// After the action body, so after its unitOfWork.CommitAsync: a scope dropped ahead of the
// commit leaves a window in which a concurrent reader caches pre-commit rows.
if (executed.Exception is not null || !Succeeded(executed.Result))
{
    return;
}

if (RouteScope.Resolve<TId>(context.RouteData, routeValueName) is { } scopeId)
{
    // Not the request's token: the write already happened, so a client that walked away
    // must not leave the cache stale.
    await cache.InvalidateAsync(CacheScope.For(scopeId), CancellationToken.None);
}
```

`InvalidateAsync` is one call, [`RemoveByTagAsync`](https://learn.microsoft.com/aspnet/core/performance/caching/hybrid), which drops every entry of that workspace **for every user**. The scope is deliberately coarse: a write that names its workspace cannot forget a route the way a list of routes would. HybridCache records the tag invalidation in the shared store, so another replica checks its in-process copy against it rather than serving it stale, with no message to broadcast.

> **_Note:_**  A write that does not go through an attributed action (a message consumer, a seeder, a bulk `ExecuteUpdate`) does not invalidate. The short expiry bounds that gap, which is why it is a minute rather than an hour.


## Failure modes
Every failure degrades to "read from the source". Redis unreachable on a read or a write-back is logged, and the request is served normally; a failed invalidation is logged as an error, and the entries expire on their own. With no cache connection string, the cache is **switched off**, not turned into a per-replica memory cache that invalidation cannot reach across replicas.


## What not to cache
Keying by subject is necessary, not sufficient. A route is a candidate only if its body derives from data inside its scope alone: a live counter (workspaces used against a plan limit) or names owned by another service have writers no `[InvalidatesCache]` will see. Cursor-paged lists over moving data, like notifications, are out too.


## Conclusion
Caching an authenticated API safely comes down to a few decisions: `no-store` by default; a shared output cache only for the response that is the same for everyone, closed to credentials and placed after authorization; and otherwise a key that cannot be built without its subject, with the authorization replayed before each hit. Invalidate after the commit, coarsely, and keep the expiry short as the backstop.

This is how response caching is built in [Blouppy Starter](https://starter.blouppy.com/), where the per-caller tier waits, already wired, for a product's first reference list.


## References
- [RFC 9111: HTTP Caching](https://www.rfc-editor.org/rfc/rfc9111) (IETF) — `Cache-Control`, `no-store`, shared caches and heuristic freshness.
- [Output caching middleware](https://learn.microsoft.com/aspnet/core/performance/caching/output) (Microsoft Learn) — policies, tags, eviction and the default rules for authenticated requests.
- [HybridCache library](https://learn.microsoft.com/aspnet/core/performance/caching/hybrid) (Microsoft Learn) — the two-level cache, tags and `RemoveByTagAsync`.
- [`HybridCacheEntryFlags`](https://learn.microsoft.com/dotnet/api/microsoft.extensions.caching.hybrid.hybridcacheentryflags) (API reference) — `DisableUnderlyingData` and the other flags.
- [Response caching in ASP.NET Core](https://learn.microsoft.com/aspnet/core/performance/caching/response) (Microsoft Learn) — the `[ResponseCache]` attribute and the headers it writes.
- [Resource-based authorization](https://learn.microsoft.com/aspnet/core/security/authorization/resourcebased) (Microsoft Learn) — imperative checks with `IAuthorizationService`.
- [Filters in ASP.NET Core](https://learn.microsoft.com/aspnet/core/mvc/controllers/filters) (Microsoft Learn) — action filters and `IFilterFactory`.
- [ASP.NET Core middleware](https://learn.microsoft.com/aspnet/core/fundamentals/middleware/) (Microsoft Learn) — middleware and pipeline order.
- [Cache-Control](https://developer.mozilla.org/docs/Web/HTTP/Headers/Cache-Control) (MDN) — the directives in practice.
