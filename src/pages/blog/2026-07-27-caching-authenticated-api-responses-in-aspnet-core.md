---
templateKey: 'blog-post'
title: 'Caching authenticated API responses in ASP.NET Core without leaking data'
date: 2026-07-27T09:00:00.000Z
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

In ASP.NET Core, caching a response is one attribute away: `[OutputCache]` on the action, `app.UseOutputCache()` in the pipeline, done. The trouble starts when the authorization happens **inside the action**. A cache that answers before the action runs also answers before that check: keyed by the path, user B gets user A's workspace. And even when it is not, a user removed from a workspace a minute ago can keep reading it from the cache.

There is a quieter problem too: a response with **no** `Cache-Control` header is not saying "do not cache me". A proxy may store it heuristically, and the browser keeps it for the back button.

In this article, we will build caching for an ASP.NET Core API in three tiers, around one rule: **never key a response by anything less than its subject**.


## The trap, stated precisely
Let's look at a typical action. The authorization is imperative, because it depends on the resource (`IsAuthorizedAsync` is a small extension that returns `AuthorizeAsync(...).Succeeded`):

```csharp
if (!await authorizationService.IsAuthorizedAsync(User, new WorkspaceId(id), Policies.Read))
{
    return Forbid();
}
```

It is tempting to conclude that *nothing* may answer before the action runs. That is true of a cache keyed by the **path**: the first member's response is served to the next non-member. It is false of a cache keyed by **subject + path**: a non-member looks up their own key, finds nothing, the action runs, and they get their `403`.

What survives is narrower: a user who *was* authorized and has since been revoked keeps reading their own entry until it expires. We will close that one too, by replaying the same policy before serving a hit.

So the constraint is not "never answer before the action". It is: never key a response by anything less than its subject.


## Three tiers

| Tier | What                     | Mechanism                     | Store                       |
| ---- | ------------------------ | ----------------------------- | --------------------------- |
| 0    | everything               | `no-store` by default         | none                        |
| 1    | an anonymous catalog     | ASP.NET Core output caching   | shared, in the API's memory |
| 2    | authenticated lists      | a per-caller cache            | HybridCache (local + Redis) |


## Tier 0: nothing is cacheable by default
Let's start with a middleware that stamps `no-store` on every API response, **unless the endpoint already said something**:

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

Here is why each choice matters:
- **A middleware, not an MVC filter**, so it also lands on redirects, 404s and error bodies.
- **`OnStarting`** runs just before the headers are sent, so the endpoint has already had its say.
- **"Unless it already has one"** is the opt-in, and the whole enforcement mechanism. An endpoint that says `public, max-age=60` keeps it, an event stream that says `no-cache, no-transform` keeps it, and a controller written next year that says nothing is not cacheable. There is no list of routes to keep in sync.


## Tier 1: one shared response, because there is exactly one
A shared cache is only safe for a response that is the same for every caller. Let's take an anonymous list of billing plans: no authorization inside the action, nothing for a cache to skip.

We write the output cache policy out instead of relying on the default:

```csharp
internal static class ResponseCachePolicies
{
    public const string PublicCatalog = nameof(PublicCatalog);

    public const string PublicCatalogTag = "billing:catalog";

    public static void AddBlouppyPolicies(this OutputCacheOptions options)
    {
        options.AddPolicy(PublicCatalog, policy => policy
            .Expire(TimeSpan.FromSeconds(60))
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

The load-bearing line is `.With(...)`: a request carrying an `Authorization` or a `Cookie` header is neither stored nor served from the cache. We check the **headers** rather than `HttpContext.User`, because the headers are there regardless of where the middleware sits relative to authentication.

Then we register it and put the middleware in an unusual place:

```csharp
services.AddOutputCache(options => options.AddBlouppyPolicies());

app.UseRouting();
app.UseAuthentication();
app.UseAuthorization();

// After authorization, not at the usual spot behind UseRouting: output caching answers a
// request without running its endpoint, so a policy added later still cannot bypass the
// pipeline's own checks.
app.UseOutputCache();
```

The action opts in with `[OutputCache(PolicyName = ResponseCachePolicies.PublicCatalog)]`, which keeps a copy on the server, and `[ResponseCache(Duration = 60, Location = ResponseCacheLocation.Any)]`, which writes a `public, max-age=60` header that Tier 0 then leaves alone.

> **_Note:_**  Nothing evicts this tag, on purpose: the catalog is written at startup and never at runtime, so the 60-second expiry is the entire invalidation story. The day an admin endpoint edits a plan, it calls `EvictByTagAsync` on that tag. 😉


## Tier 2: per caller, keyed by the subject
For anything authenticated, we put our own small port in front of **HybridCache**:

```csharp
public interface IResponseCache
{
    Task<string?> TryGetAsync(ResponseCacheKey key, CancellationToken cancellationToken = default);

    Task SetAsync(ResponseCacheKey key, CacheScope scope, string payload, CancellationToken cancellationToken = default);

    Task InvalidateAsync(CacheScope scope, CancellationToken cancellationToken = default);
}
```

The interesting part is not the interface, it is the key:

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

The constructor is private and the only factory takes a `UserId` (a strongly-typed id). A cross-user entry is not discouraged, it is **inexpressible**. The request signature is the method, the path and the query string, taken verbatim:

```csharp
var signature = $"{request.Method} {request.Path.Value}?{request.QueryString.Value}";

return ResponseCacheKey.ForUser(currentUserService.UserId, signature);
```

Verbatim rather than normalized: two spellings of the same request become two entries, which costs a miss, whereas dropping a parameter would return the wrong body.

### The filter that replays the authorization
A cached route declares it with an attribute, and the action body stays untouched. Let's say our product has a list of categories per workspace:

```csharp
[HttpGet]
[CachedResponse<WorkspaceId>(Policies.Read)]
public async Task<ActionResult<OffsetPage<CategoryDto>>> GetPageAsync(int workspaceId, ...)
```

Here is the heart of its filter:

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

Let's go through it:
- **The scope comes from the route**, from the parameter named after the id's type (`WorkspaceId` → `{workspaceId}`), so there is no argument for a call site to get wrong.
- **The policy runs before the lookup.** It has the principal, the route value and `IAuthorizationService`, which is everything the action's own check uses. A revoked user stops being served immediately, not when the entry expires.
- **On a miss**, the action runs with its own check, and only a successful `200` is stored. A `403` or an exception is never cached.
- **The payload is the rendered JSON**, serialized with MVC's own `JsonSerializerOptions`. That is not a detail: with a `JsonStringEnumConverter` registered, serializing with defaults would make a hit answer `"colour": 3` where a miss answers `"colour": "Red"`.

So two properties hold, and either one is enough on its own: the key cannot be built without a subject, and the filter re-authorizes before serving.

### A plain read on HybridCache
HybridCache is built around `GetOrCreateAsync`. To get a plain "read, never produce", we make the factory unreachable:

```csharp
private static readonly HybridCacheEntryOptions ProbeOptions = new()
{
    Flags = HybridCacheEntryFlags.DisableUnderlyingData
};

return await cache.GetOrCreateAsync<string?>(
    key.Value,
    static _ => ValueTask.FromResult<string?>(null),
    ProbeOptions,
    cancellationToken: cancellationToken);
```

The call is wrapped in a `try`/`catch` that logs and returns `null`: a cache is an optimization, never a dependency.

`SetAsync` stores the payload with `scope.ToString()` (for example `workspace:12`) as a **tag**, a 60-second `Expiration` and a 15-second `LocalCacheExpiration` for the in-process copy.


## Invalidation
A write says which scope it dirties, and nothing else:

```csharp
[HttpPost]
[InvalidatesCache<WorkspaceId>]
public async Task<ActionResult<CategoryDto>> CreateAsync(int workspaceId, ...)
```

The filter behind it runs **after** the action body:

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

`InvalidateAsync` is one call, `cache.RemoveByTagAsync(scope.ToString(), cancellationToken)`, and it drops every entry of that workspace, **for every user**. The scope is deliberately coarse: a write that names its workspace cannot forget a route the way a list of routes would.

HybridCache records the tag invalidation in the shared store, so an in-process copy on another replica is checked against it rather than served stale. That is what lets us keep a local tier without broadcasting a message to every replica.

> **_Note:_**  What this does not catch: a write that does not go through an attributed action, such as a message consumer, a seeder or a bulk `ExecuteUpdate`. Hooking EF's change tracker would catch those, but it puts HTTP knowledge in the persistence layer. The expiry bounds that trade, which is why the duration is a minute rather than an hour.


## Failure modes
Every failure degrades to "read from the source":
- **Redis unreachable on read or write-back**: logged, the request is served normally.
- **Invalidation fails**: logged as an error, the entries expire on their own.
- **No cache connection string**: the cache is **switched off** (`options.Enabled = false`), not quietly turned into a per-replica memory cache that no invalidation can reach across replicas. Degrading into the very hazard we are avoiding is worse than not caching.


## What not to cache
Keying by subject is necessary, not sufficient. Before adding a route, let's ask two questions:
1. **Is the body a value, not a "found or not"?** A not-found branch is a second shape to get right, and lists are the hot path anyway.
2. **Does the body derive only from data inside its scope?** A live counter (workspaces used against a plan limit), or names and avatars owned by another service, have writers no `[InvalidatesCache]` will ever see.

If either answer is no, the route is not a candidate. Neither are cursor-paged lists over moving data, like notifications: a cached page and a moving cursor do not mix.


## Conclusion
Caching an authenticated API safely comes down to a few decisions. Make `no-store` the default, so silence is never an accident. Keep the shared output cache for the one response that is truly the same for everyone, refuse it any request with credentials, and place it after authorization. And for everything else, use a key that cannot be built without its subject, and replay the authorization before serving a hit.

For invalidation, drop the scope after the commit, keep it coarse, and keep the expiry short: it is the backstop behind every other argument.

This is how response caching is built in [Blouppy Starter](https://starter.blouppy.com/), an ASP.NET Core API behind an Angular application, where the per-caller tier waits, already wired, for a product's first reference list.

*Thanks for reading! 🙂*
