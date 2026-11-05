---
templateKey: 'blog-post'
title: 'Personal access tokens in ASP.NET Core: reference tokens, not hashes'
date: 2026-08-08T09:00:00.000Z
author: Jimmy Boinembalome
authorimage: /img/jimmy.jpg
category: C#
categorycolor: bg-purple-100 text-purple-800
featuredpost: true
featuredimage: /img/personal-access-tokens-in-aspnet-core.jpg
description: >-
  Learn how to give your users personal access tokens for their scripts and agents, minted by OpenIddict as reference tokens and introspected by your ASP.NET Core API.
tags:
  - Development
  - C#
  - ASP.NET Core
  - OpenIddict
  - Security
---

Sooner or later, a user asks for it: "can my script call the API as me?". A browser has a session, but a script, an editor extension or an agent cannot run a sign-in page. They need a credential of their own, the kind GitHub calls a **personal access token**. It must act as one user and never more, expire, be revocable alone, be recognisable when leaked, and be rate limited.

The usual first idea is to generate a random string, store its hash in a table and let the API compare hashes. It works on day one. But it quietly turns the API into a second token issuer.

In this article, we will see a different design: the tokens are **reference tokens** minted by an **OpenIddict** identity server, and the ASP.NET Core API **introspects** them and caches the answer. We will look at the minting, the revocation of one token at a time, the prefix, the rules, how the API accepts a token, and what this costs.


## Why not a hash the API checks?
A hashed token checked by the API is simpler on its first day and worse after. The API would have to answer questions that already have an owner:
- **Is this account still allowed in, and with which roles?** That is the identity server's business. With hashes, the API has to learn it.
- **What about OAuth later?** The day a third-party client connects, the API would need a second validation path beside the hash one.

So the decision is the opposite: **a personal access token is a reference token of the identity server**. The identity server stays the one authority over who a user is and what a token allows. The API only asks: "is this token active, and what are its claims?". That question has a standard answer, the OAuth 2.0 **introspection** endpoint.

> **_Note:_**  A reference token is an opaque handle. The real payload is stored on the server, which means it can be revoked instantly, unlike a self-contained JWT that stays valid until it expires.


## A client that can request nothing
Every token OpenIddict issues belongs to a client. Let's define one for personal access tokens, beside the other clients, in `Server/ServerConfiguration.cs`:

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

What matters is what is **missing**: no `Permissions`, so no endpoint and no grant type. No request can ever get a token for this client: the only way is to mint it in process, behind endpoints that require a browser session.

The API is also a client, `blouppy_api`, confidential, with a secret and one permission alone: `Permissions.Endpoints.Introspection`. It can introspect, and do nothing else.


## Minting through OpenIddict's own pipeline
OpenIddict's server is a pipeline of events, and `GenerateTokenContext` is what its token endpoint uses to produce a token. Let's dispatch it ourselves. Here is the heart of `OpenIddictPersonalAccessTokenMinter`:

```csharp
var principal = new ClaimsPrincipal(identity)
    .SetScopes(scopes)
    .SetAudiences(["blouppy_api"])
    .SetAuthorizationId(tokenId)
    .SetCreationDate(now)
    .SetExpirationDate(now + lifetime)
    .SetClaim(Claims.ClientId, PersonalAccessTokenRules.ClientId);

var transaction = await serverFactory.CreateTransactionAsync();

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
    throw new InvalidOperationException($"OpenIddict refused to mint the personal access token: {context.Error}");
}

return context.Token;
```

- The `identity` comes from the same factory that builds the browser's access token, minus the name, e-mail and picture claims: the API needs the subject and the roles, not a profile.
- `IsReferenceToken = true` and `PersistTokenPayload = true`: the signed payload is stored in OpenIddict's tokens table, and what comes back in `context.Token` is only a **handle**. The table keeps a hash of that handle, never the handle itself.

So introspecting it later is introspecting any other reference token. 👍


## One authorization per token
Users want to revoke **one** token, the one they pasted in a CI log, without killing the others. OpenIddict revokes by authorization, so the trick is to give each token an **ad-hoc authorization whose id is the token's own id**. Just before the code above, the minter creates it:

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

And revoking one token becomes two calls:

```csharp
await authorizationManager.TryRevokeAsync(authorization, cancellationToken);
await tokenManager.RevokeByAuthorizationIdAsync(tokenId, cancellationToken);
```

Beside OpenIddict's tables, a `personal_access_tokens` table holds what the user sees in the list: the name, the scopes, the creation and expiry dates, the last use and the revocation. **Never the secret.** Its row has the same id as the authorization.

> **_Note:_**  The order matters. The token is minted **before** the row is written. A grant without a row is refused at introspection (we will see how), whereas a row without a grant would list a token that can never work.


## A prefix you can recognise
What the user copies is not the bare handle. It is prefixed:

```csharp
return PersonalAccessTokenCreationResult.Success(new IssuedPersonalAccessToken(
    token,
    PersonalAccessTokenRules.Prefix + handle)); // "blp_pat_..."
```

A token pasted in an issue or a commit is recognisable at a glance, and a secret scanner can be taught to look for it. The prefix also tells the API which scheme to use.


## The rules
All the fixed numbers live in one class, `PersonalAccessTokenRules`:

```csharp
public static class PersonalAccessTokenRules
{
    public const string ReadScope = "blouppy.read";
    public const string WriteScope = "blouppy.write";
    public const string Prefix = "blp_pat_";
    public const int NameMaxLength = 100;
    public const int MaxActiveTokensPerUser = 20;

    // A year, and the day a date picker in another time zone may round up to.
    public static readonly TimeSpan MaxLifetime = TimeSpan.FromDays(366);

    public static IReadOnlyList<string> Normalize(IEnumerable<string> scopes)
        => scopes.Contains(WriteScope, StringComparer.Ordinal)
            ? [ReadScope, WriteScope]
            : [ReadScope];
}
```

- **Two scopes**, _Read_ or _Read and write_. `Normalize` makes `write` imply `read`, so the stored set is always one of the two.
- **An expiry is mandatory**, within a year: a leaked token must not be a permanent account.
- **At most 20 active tokens** per user: a loop creating tokens stops early.

On creation, the user also gets an e-mail, as GitHub sends one.


## What OpenIddict cannot know
OpenIddict knows whether a token is valid, but not whether its row was revoked or still belongs to its subject. A custom handler on `ValidateIntrospectionRequestContext` adds that check, `IntrospectionRulesHandler`:

```csharp
if (principal.GetClaim(Claims.ClientId) == PersonalAccessTokenRules.ClientId)
{
    var tokenId = principal.GetAuthorizationId();
    var token = tokenId is null ? null : await repository.TryGetAsync(tokenId, context.CancellationToken);
    var now = timeProvider.GetUtcNow();

    if (token is null || token.UserId != subject || token.IsRevoked || token.IsExpiredAt(now))
    {
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

A rejection with `invalid_token` is answered as `active: false`. The handler also records **last used**, at most every five minutes: the API caches introspections for a minute anyway.


## How the API accepts one
The API already validates the browser's JWT. We do not want a browser request to cost one more cent. So the default scheme becomes a **policy scheme** that looks at the bearer:

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

A bearer starting with `blp_pat_` (case-sensitive) goes to the introspection scheme, which strips the prefix before asking. Anything else goes to the JWT handler, unchanged.

The introspection itself is OpenIddict's validation (`AddOpenIddict().AddValidation(...)`) in introspection mode, as the `blouppy_api` client, with `UseIntrospection().SetClientId("blouppy_api")` and `UseSystemNetHttp()`. The `/connect/introspect` endpoint is named in an `OpenIddictConfiguration` rather than discovered, so the first token does not wait on a discovery round trip.

Then a custom `AuthenticationHandler`, `IntrospectedTokenHandler`, calls `OpenIddictValidationService.ValidateAccessTokenAsync` and keeps the answer in `HybridCache`:

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

- The cache key is a **hash** of the handle: a cache dump does not leak a usable token.
- The lifetime is `ApiAccessRules.IntrospectionCacheDuration`, **60 seconds**, or less when the token expires sooner.
- A refusal (`active: false`) is cached too, so a revoked token hammering the API does not hammer the identity server. A failure to answer is **not** cached.


## Policies that widen by scope
The browser's token carries the `blouppy_api` scope. A personal access token carries `blouppy.read`, or `blouppy.read` and `blouppy.write`, and never `blouppy_api`. The policies list what they accept:

```csharp
public static IReadOnlyList<string> Reading { get; } = [Browser, Read, Write];
public static IReadOnlyList<string> Writing { get; } = [Browser, Write];
```

```csharp
options.AddPolicy(Policies.Contribute, policy =>
    policy
        .RequireAuthenticatedUser()
        .RequireClaim(BlouppyClaimTypes.Scope, ApiScopes.Writing)
        .AddRequirements(
            new MinimumRoleRequirement(OrganizationRole.Member),
            new ApiAndMcpAccessRequirement(ApiAndMcpAccessLevel.ReadWrite)));
```

`Policies.Manage` is the same with `ApiScopes.Browser` alone. The policies widen **by scope, never by client**: a token reads, a write token contributes, and only the browser manages an organization. On top of that, the default policy carries a `WriteScopeRequirement`: any request that is not `GET`, `HEAD` or `OPTIONS` needs a scope that may write. Without it, a read token could still write wherever no resource-based policy guards the write, like marking a notification read.

The `ApiAndMcpAccessRequirement` is the organization's say. An owner can set **API & MCP access** to `Off`, `Read` or `ReadWrite` (the default), and it caps what any token may do in that organization, whatever the token's own scope. The browser's requests never read the setting.

How does the guard know a request came from a token? It asks `ICurrentUserService.Channel`, `ActorChannel.Api` when the introspection scheme authenticated the request, `ActorChannel.App` otherwise. The guard and the rate limiter both ask this one property, rather than each reading claims.


## Rate limits for tokens only
Requests made with a token go through a global partitioned limiter, chained from three partitions, all in `ApiAccessRules`:
- **Per token**, 120 requests per minute, as a token bucket with a burst of 30.
- **Per token, writes**, 30 per minute: writes notify people, and a runaway agent should not flood a team.
- **Per user, across tokens**, 300 per minute: twenty tokens must not mean twenty times the budget.

The browser gets `RateLimitPartition.GetNoLimiter`. A refusal is a `429` with `Retry-After`, logged with the partitions it exhausted, since the numbers are a first guess.


## The trade-off
Nothing is free. Here is what this design costs:
- **An introspection call** to the identity server for each token, once per minute. Cheap, but it is a dependency: if the identity server is down, uncached tokens are refused.
- **A revoked token may keep working for up to 60 seconds**, the cache duration. That is the explicit bound.
- **A shared secret** between the two hosts, for the API's client. Without it, the API refuses every token with a 401 and logs a warning at startup.

In exchange, the identity server stays the single authority, and an OAuth client added later goes through exactly the same door. 😉


## Conclusion
Personal access tokens look like a small feature. But checking hashes in the API makes it a second issuer, which has to learn about accounts and roles on its own.

With reference tokens, OpenIddict mints the token through its own pipeline, one ad-hoc authorization per token lets us revoke it alone, the `blp_pat_` prefix makes it recognisable, and the API introspects it, caches the answer for a minute and widens its policies by scope. The price: a revocation can take up to that minute to bite.

This is how personal access tokens are built in [Blouppy Starter](https://starter.blouppy.com/), where the same tokens also reach its MCP server. The [identity documentation](https://docs.starter.blouppy.com/architecture/identity/) explains the server they come from.

*Thanks for reading! 🙂*
