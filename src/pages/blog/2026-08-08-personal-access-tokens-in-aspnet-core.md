---
templateKey: 'blog-post'
title: 'Personal access tokens in ASP.NET Core: reference tokens, not hashes'
date: 2026-08-08T09:00:00.000Z
updated: 2026-11-07T09:00:00.000Z
author: Jimmy Boinembalome
authorimage: /img/jimmy.jpg
category: C#
topic: 'Security'
illustration: 2
categorycolor: bg-purple-100 text-purple-800
featuredpost: true
featuredimage: /img/personal-access-tokens-in-aspnet-core.jpg
description: >-
  Learn how to give users personal access tokens for their scripts and agents, minted by OpenIddict as reference tokens and introspected by an ASP.NET Core API.
tags:
  - Development
  - C#
  - ASP.NET Core
  - OpenIddict
  - Security
---

Sooner or later, a user asks: "can my script call the API as me?". A script, an editor extension or an agent cannot go through a sign-in page. They need a credential of their own, what GitHub calls a [personal access token](https://docs.github.com/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens). It must act as one user and never more, expire, be revocable on its own, be recognisable when leaked, and be rate limited.

The usual first idea is to generate a random string, store its hash and let the API compare hashes. It works on day one, but it quietly turns the API into a second token issuer.

In this article, we will build a different design: the tokens are **reference tokens** minted by an [OpenIddict](https://documentation.openiddict.com/) identity server, and the ASP.NET Core API **introspects** them and caches the answer.


## Why not a hash the API checks?
A hash checked by the API would have to answer questions that already have an owner:
- **Is this account still allowed in, and with which roles?** That is the identity server's business.
- **What about OAuth later?** The day a third-party client connects, the API needs a second validation path beside the hash one.

So **a personal access token is a reference token of the identity server**. The identity server stays the one authority over who a user is and what a token allows. The API only asks "is this token active, and what are its claims?", which has a standard answer: the [OAuth 2.0 token introspection](https://datatracker.ietf.org/doc/html/rfc7662) endpoint.

> **_Note:_**  A [reference token](https://documentation.openiddict.com/configuration/token-storage) is an opaque handle. Its payload stays in the server's database, so a resource server has to ask the server about it, and learns about a revocation at its next introspection.


## A client that can request nothing
Every token OpenIddict issues belongs to a client. The personal access tokens get one, in `Server/ServerConfiguration.cs`:

```csharp
private static OpenIddictApplicationDescriptor PersonalAccessTokens()
    => new()
    {
        ClientId = PersonalAccessTokenRules.ClientId, // "blouppy-personal-access-tokens"
        ClientType = ClientTypes.Public,
        ConsentType = ConsentTypes.Implicit,
        DisplayName = "Blouppy personal access tokens"
    };
```

What matters is what is **missing**: no `Permissions`, so no endpoint and no grant type. No request can obtain a token for this client; the only way is to mint one in process, behind endpoints that require a browser session.

The API is a client too, `blouppy_api`: confidential, with a secret, and a single permission, `Permissions.Endpoints.Introspection`.


## Minting through OpenIddict's own pipeline
OpenIddict's server is a pipeline of events, and `GenerateTokenContext` is what its token endpoint dispatches to produce a token. `OpenIddictPersonalAccessTokenMinter` dispatches it itself (abridged):

```csharp
var principal = new ClaimsPrincipal(identity)
    .SetScopes(scopes)
    .SetAudiences(audiences) // the API and the MCP resource, read from the scopes' definitions
    .SetAuthorizationId(tokenId)
    .SetCreationDate(now)
    .SetExpirationDate(now + lifetime)
    .SetClaim(Claims.ClientId, PersonalAccessTokenRules.ClientId);

var transaction = await serverFactory.CreateTransactionAsync();

transaction.CancellationToken = cancellationToken;

var context = new GenerateTokenContext(transaction)
{
    ClientId = PersonalAccessTokenRules.ClientId,
    CreateTokenEntry = true,
    IsReferenceToken = true,
    PersistTokenPayload = true,
    Principal = principal,
    TokenFormat = TokenFormats.Private.JsonWebToken,
    TokenType = TokenTypeIdentifiers.AccessToken
};

await serverDispatcher.DispatchAsync(context);

if (context.IsRejected || string.IsNullOrEmpty(context.Token))
{
    throw new InvalidOperationException($"OpenIddict refused to mint the personal access token: {context.Error} {context.ErrorDescription}");
}

return context.Token;
```

The `identity` comes from the factory that builds the browser's access token, minus the name, e-mail and picture claims: the API needs the subject and the roles, not a profile. With `IsReferenceToken` and `PersistTokenPayload`, the signed payload is stored in OpenIddict's tokens table and `context.Token` is only a **handle**, so introspecting it later is introspecting any other reference token.


## One authorization per token
Users want to revoke **one** token, the one they pasted in a CI log, without killing the others. OpenIddict revokes by authorization, so each token gets an **ad-hoc authorization whose id is the token's own id**. The minter creates it first:

```csharp
var authorization = new OpenIddictEntityFrameworkCoreAuthorization { Id = tokenId };

var descriptor = new OpenIddictAuthorizationDescriptor
{
    ApplicationId = applicationId,
    CreationDate = now,
    Status = Statuses.Valid,
    Subject = userId,
    Type = AuthorizationTypes.AdHoc
};

descriptor.Scopes.UnionWith(scopes);

await authorizationManager.PopulateAsync(authorization, descriptor, cancellationToken);
await authorizationManager.CreateAsync(authorization, cancellationToken);
```

Revoking one token then takes two calls:

```csharp
await authorizationManager.TryRevokeAsync(authorization, cancellationToken);
await tokenManager.RevokeByAuthorizationIdAsync(tokenId, cancellationToken);
```

Beside OpenIddict's tables, a `personal_access_tokens` table holds what the user sees: the name, the scopes, the creation and expiry dates, the last use and the revocation, but **never the secret**. Its row has the same id as the authorization.

> **_Note:_**  The token is minted **before** the row is written. A grant without a row is refused at introspection, whereas a row without a grant would list a token that can never work.


## A recognisable prefix
What the user copies is the handle behind a prefix, `PersonalAccessTokenRules.Prefix + handle`, which reads `blp_pat_...`. A token pasted in an issue or a commit is recognisable at a glance, and a [secret scanner](https://docs.github.com/code-security/concepts/secret-security/secret-scanning) can be taught to look for it. The prefix also tells the API which scheme to use.


## The rules
The fixed numbers live in one class, `PersonalAccessTokenRules`:
- **Two scopes**, `blouppy.read` or `blouppy.read` and `blouppy.write`: its `Normalize` method makes `write` imply `read`.
- **An expiry is mandatory**, within `MaxLifetime` (366 days: a year, and the day a date picker in another time zone may round up to). A leaked token must not be a permanent account.
- **At most 20 active tokens** per user (`MaxActiveTokensPerUser`), so a loop creating tokens stops early.

On creation, the user also receives an e-mail, as GitHub sends one.


## What OpenIddict cannot know
OpenIddict knows whether a token is valid, not whether its row was revoked or still belongs to its subject. `IntrospectionRulesHandler`, a custom handler on `ValidateIntrospectionRequestContext`, adds that check:

```csharp
if (principal.GetClaim(Claims.ClientId) == PersonalAccessTokenRules.ClientId)
{
    var tokenId = principal.GetAuthorizationId();
    var token = tokenId is null
        ? null
        : await repository.TryGetAsync(tokenId, context.CancellationToken);
    var now = timeProvider.GetUtcNow();

    if (token is null || token.UserId != subject || token.IsRevoked || token.IsExpiredAt(now))
    {
        logger.PersonalAccessTokenRefused(tokenId);

        context.Reject(Errors.InvalidToken);

        return;
    }

    if (token.LastUsedAt is null || now - token.LastUsedAt >= PersonalAccessTokenRules.LastUsedPrecision)
    {
        token.LastUsedAt = now;

        await unitOfWork.CommitAsync(context.CancellationToken);
    }
}
```

A rejection with `invalid_token` is answered as `active: false`. The handler records **last used** at most every five minutes, since the API caches introspections for a minute anyway. The same handler also refuses any token of an account that an organization's identity provider deactivated.


## How the API accepts one
The API already validates the browser's JWT, and a browser request must not cost an extra call. So the default scheme is a [policy scheme](https://learn.microsoft.com/aspnet/core/security/authentication/policyschemes) that looks at the bearer:

```csharp
public static string SelectScheme(HttpContext context)
    => IsPersonalAccessToken(ReadBearer(context.Request))
        ? ApiAuthenticationSchemes.PersonalAccessToken
        : ApiAuthenticationSchemes.Jwt;

public static string? ReadHandle(HttpRequest request)
    => ReadBearer(request) is { } bearer && IsPersonalAccessToken(bearer)
        ? bearer[Prefix.Length..]
        : null;
```

A bearer starting with `blp_pat_` (case-sensitive) goes to the introspection scheme, which strips the prefix before asking. Anything else goes to the JWT handler.

The introspection itself is OpenIddict's validation in introspection mode, as the `blouppy_api` client: `UseIntrospection().SetClientId("blouppy_api")` with [`UseSystemNetHttp()`](https://documentation.openiddict.com/integrations/system-net-http). The `/connect/introspect` endpoint is set in an `OpenIddictConfiguration` rather than discovered, so the first token does not wait on a discovery round trip.

A custom `AuthenticationHandler`, `IntrospectedTokenHandler`, calls `OpenIddictValidationService.ValidateAccessTokenAsync` and keeps the answer in [`HybridCache`](https://learn.microsoft.com/aspnet/core/performance/caching/hybrid):

```csharp
var key = Options.CacheKeyPrefix + Hash(handle); // SHA-256 of the handle, never the handle

// ...on a cache miss:
(token, var lifetime) = await IntrospectAsync(handle);

await cache.SetAsync(
    key,
    token,
    new HybridCacheEntryOptions { Expiration = lifetime, LocalCacheExpiration = lifetime },
    cancellationToken: Context.RequestAborted);
```

The cache key is a **hash** of the handle, so a cache dump leaks no usable token. The lifetime is `ApiAccessRules.IntrospectionCacheDuration`, **60 seconds**, or less when the token expires sooner. A refusal (`active: false`) is cached too, so a revoked token hammering the API does not hammer the identity server; a failure to answer is **not** cached.


## Policies that widen by scope
The browser's token carries the `blouppy_api` scope. A personal access token carries `blouppy.read`, optionally with `blouppy.write`, and never `blouppy_api`. The [authorization policies](https://learn.microsoft.com/aspnet/core/security/authorization/policies) list what they accept:

`ApiScopes.Reading` is `[Browser, Read, Write]` and `ApiScopes.Writing` is `[Browser, Write]`:

```csharp
options.AddPolicy(Policies.Contribute, policy =>
    policy
        .RequireAuthenticatedUser()
        .RequireClaim(BlouppyClaimTypes.Scope, ApiScopes.Writing)
        .AddRequirements(
            new MinimumRoleRequirement(OrganizationRole.Member),
            new ApiAndMcpAccessRequirement(ApiAndMcpAccessLevel.ReadWrite)));
```

`Policies.Manage` requires `ApiScopes.Browser` alone (and the admin role). The policies widen **by scope, never by client**: a token reads, a write token contributes, and only the browser manages an organization. The default policy also carries a `WriteScopeRequirement`: any request other than `GET`, `HEAD` or `OPTIONS` needs a scope that may write. Without it, a read token could still write wherever no resource-based policy guards the write, such as marking a notification read.

`ApiAndMcpAccessRequirement` is the organization's say: an owner sets **API & MCP access** to `Off`, `Read` or `ReadWrite` (the default), which caps what any token may do there. The guard, like the rate limiter, tells a token from the browser by `ICurrentUserService.Channel`: `ActorChannel.Api` or `ActorChannel.App`.


## Rate limits for tokens only
Token requests go through a global partitioned [rate limiter](https://learn.microsoft.com/aspnet/core/performance/rate-limit) chained from three partitions, all in `ApiAccessRules`:
- **Per token**: 120 requests per minute, as a token bucket with a burst of 30.
- **Per token, writes**: 30 per minute, because writes notify people.
- **Per user, across tokens**: 300 per minute, so twenty tokens do not mean twenty times the budget.

The browser gets `RateLimitPartition.GetNoLimiter`. A refusal is a `429` with `Retry-After`, logged with the exhausted partitions so the numbers can be tuned.


## The trade-off
This design has costs:
- **An introspection call** per token and per minute: cheap, but a dependency. If the identity server is down, uncached tokens are refused.
- **A revoked token may keep working for up to 60 seconds**, the cache duration. That is the explicit bound.
- **A shared secret** between the two hosts for the API's client. Without it, the API refuses every token with a 401 and logs a warning at startup.

In exchange, the identity server stays the single authority, and a future OAuth client goes through the same door.


## Conclusion
Checking hashes in the API makes it a second issuer. With reference tokens, OpenIddict mints each token through its own pipeline, one ad-hoc authorization per token makes it revocable alone, the `blp_pat_` prefix makes it recognisable, and the API introspects it, caches the answer for a minute and widens its policies by scope.

This is how personal access tokens work in [Blouppy Starter](https://starter.blouppy.com/), where the same tokens also reach its MCP server. The [identity documentation](https://docs.starter.blouppy.com/architecture/identity/) describes the server they come from.


## References
- [RFC 7662: OAuth 2.0 Token Introspection](https://datatracker.ietf.org/doc/html/rfc7662) — the introspection request and its `active` answer.
- [OpenIddict: Token storage](https://documentation.openiddict.com/configuration/token-storage) — token entries and reference tokens.
- [OpenIddict: System.Net.Http integration](https://documentation.openiddict.com/integrations/system-net-http) — the HTTP client the validation handler uses to introspect.
- [Policy schemes in ASP.NET Core](https://learn.microsoft.com/aspnet/core/security/authentication/policyschemes) — forwarding to a scheme chosen per request.
- [Policy-based authorization in ASP.NET Core](https://learn.microsoft.com/aspnet/core/security/authorization/policies) — policies, requirements and handlers.
- [HybridCache library in ASP.NET Core](https://learn.microsoft.com/aspnet/core/performance/caching/hybrid) — the two-level cache holding introspection results.
- [Rate limiting middleware in ASP.NET Core](https://learn.microsoft.com/aspnet/core/performance/rate-limit) — partitioned and chained limiters.
- [OWASP REST Security Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/REST_Security_Cheat_Sheet.html) — access control and rate limiting for APIs.
- [Managing your personal access tokens](https://docs.github.com/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens) — GitHub's model: scoped, expiring, revocable tokens.
- [About secret scanning](https://docs.github.com/code-security/concepts/secret-security/secret-scanning) — why a recognisable prefix helps.
- [Blouppy Starter: Identity](https://docs.starter.blouppy.com/architecture/identity/) — the identity server behind these tokens.
