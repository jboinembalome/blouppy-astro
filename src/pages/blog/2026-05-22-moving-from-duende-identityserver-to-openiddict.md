---
templateKey: 'blog-post'
title: 'Moving from Duende IdentityServer to OpenIddict in ASP.NET Core'
date: 2026-05-22T09:00:00.000Z
author: Jimmy Boinembalome
authorimage: /img/jimmy.jpg
category: C#
categorycolor: bg-purple-100 text-purple-800
featuredpost: true
featuredimage: /img/moving-from-duende-identityserver-to-openiddict.jpg
description: >-
  Learn how to replace Duende IdentityServer with OpenIddict while keeping the same OpenID Connect shape for your gateway, your API and your other clients.
tags:
  - Development
  - C#
  - ASP.NET Core
  - OpenIddict
  - Security
  - EF Core
---

Duende IdentityServer works well, but it is commercial in production, and its Community Edition only covers small companies. If you ship a product, or a template that other people deploy, that is a licence question you hand to every user. **OpenIddict** is Apache 2.0, runs inside your own ASP.NET Core host, and speaks the same protocol.

The good news is that the clients do not have to notice. If the issuer, the endpoints, the scopes and the claims stay the same, the gateway's OpenID Connect handler and the API's JWT validation keep working. The less good news is that OpenIddict is a lower-level framework: several things IdentityServer did for you become your code.

In this article, we will go through what an IdentityServer user has to rebuild: the server registration, the clients declared in code and synced on start, the authorize and token endpoints, the claims, the keys shared across replicas and the token pruning.


## What changes, concept by concept
Here is the mapping we will follow:

| IdentityServer | OpenIddict |
| --- | --- |
| A `Client` | An application, declared with an `OpenIddictApplicationDescriptor` |
| An `ApiScope` | A scope registered with `RegisterScopes`, and resources set on the token |
| The login and consent logic around the `/connect/authorize` endpoint | Your own controller, called in **passthrough** |
| `IProfileService` | The claims you put on the `ClaimsIdentity` you sign in, with a destination each |
| Persisted grants | OpenIddict's authorizations and tokens tables |
| Signing credentials and key management | `SigningCredentials` and `EncryptionCredentials` you provide |
| Token cleanup | `PruneAsync` on the token and authorization managers |

The protocol endpoints keep their `/connect/*` paths, and clients find them through discovery.


## Register the server
OpenIddict comes as two packages here: `OpenIddict.AspNetCore` and `OpenIddict.EntityFrameworkCore`. Its applications, authorizations, scopes and tokens can live in the same `DbContext` as ASP.NET Identity's tables, with a single call in `OnModelCreating`:

```csharp
protected override void OnModelCreating(ModelBuilder builder)
{
    builder.ApplyConfigurationsFromAssembly(typeof(ApplicationDbContext).Assembly);

    // The authorization server's applications, authorizations and tokens, beside the accounts they belong to.
    builder.UseOpenIddict();

    base.OnModelCreating(builder);
}
```

Then let's register the server itself. This is a trimmed version of `AddAuthorizationServer` and `ConfigureBlouppyServer` in `Server/ServiceCollectionExtensions.cs`:

```csharp
services
    .AddOpenIddict()
    .AddCore(options => options
        .UseEntityFrameworkCore()
        .UseDbContext<ApplicationDbContext>())
    .AddServer(options =>
    {
        options
            .SetIssuer(new Uri(blouppyConfiguration.IdentityUrl, UriKind.Absolute))
            .SetAuthorizationEndpointUris("connect/authorize")
            .SetTokenEndpointUris("connect/token")
            .SetRevocationEndpointUris("connect/revocation")
            .SetIntrospectionEndpointUris("connect/introspect")
            .SetUserInfoEndpointUris("connect/userinfo")
            .SetEndSessionEndpointUris("connect/endsession");

        options
            .AllowAuthorizationCodeFlow()
            .AllowRefreshTokenFlow()
            .RequireProofKeyForCodeExchange();

        options.RegisterScopes([.. ServerConfiguration.GetScopes(blouppyConfiguration).Select(scope => scope.Name), Scopes.OpenId, Scopes.OfflineAccess]);

        // The API validates the access token on its own, so it is signed and not encrypted.
        options.DisableAccessTokenEncryption();

        options.SetAccessTokenLifetime(ServerConfiguration.BrowserAccessTokenLifetime);

        options
            .UseAspNetCore()
            .EnableAuthorizationEndpointPassthrough()
            .EnableTokenEndpointPassthrough()
            .EnableUserInfoEndpointPassthrough()
            .EnableEndSessionEndpointPassthrough()
            .EnableErrorPassthrough();
    });
```

A few points matter for a migration:
- **`SetIssuer`** must give the same issuer the API already trusts. Note that OpenIddict adds a trailing slash to it, in discovery and in every token's `iss`.
- **`DisableAccessTokenEncryption`** is the line you will look for first: OpenIddict encrypts its access tokens by default, and an API validating JWTs with ASP.NET Core's JWT handler cannot read an encrypted one.
- **The passthrough calls** let OpenIddict validate each request, then hand it to our own controller.

## Declare the clients in code
With IdentityServer, clients are often a list of `Client` objects in code. Let's keep it that way. Each one becomes an `OpenIddictApplicationDescriptor`, in `Server/ServerConfiguration.cs`. Here is the gateway's:

```csharp
var descriptor = new OpenIddictApplicationDescriptor
{
    ClientId = BrowserClientId,
    ClientSecret = oidcClientOptions.ClientSecret,
    ClientType = ClientTypes.Confidential,
    // The first party: it asks for nothing the user has to approve.
    ConsentType = ConsentTypes.Implicit,
    DisplayName = "Blouppy",
    RedirectUris = { new Uri($"{blouppyConfiguration.GatewayUrl.TrimEnd('/')}/signin-oidc") },
    PostLogoutRedirectUris = { new Uri($"{blouppyConfiguration.GatewayUrl.TrimEnd('/')}/signout-callback-oidc") },
    Requirements = { Requirements.Features.ProofKeyForCodeExchange },
    Settings =
    {
        [Settings.TokenLifetimes.AccessToken] = BrowserAccessTokenLifetime.ToString("c", CultureInfo.InvariantCulture),
        [Settings.TokenLifetimes.IdentityToken] = BrowserIdentityTokenLifetime.ToString("c", CultureInfo.InvariantCulture)
    }
};

descriptor.Permissions.UnionWith(
[
    Permissions.Endpoints.Authorization,
    Permissions.Endpoints.Token,
    Permissions.Endpoints.EndSession,
    Permissions.Endpoints.Revocation,
    Permissions.GrantTypes.AuthorizationCode,
    Permissions.GrantTypes.RefreshToken,
    Permissions.ResponseTypes.Code,
    Permissions.Scopes.Profile,
    Permissions.Scopes.Email,
    Permissions.Prefixes.Scope + ApiResource,
    Permissions.Prefixes.Scope + IdentityApiResource
]);
```

What an IdentityServer `Client` said with `AllowedGrantTypes` and `AllowedScopes`, OpenIddict says with **permissions**: one per endpoint, grant type, response type and scope. The client ID, the secret and the redirect URIs stay what the gateway already sends, so its OpenID Connect handler does not change.


## Sync the clients on every start
A descriptor in code is only half of it: OpenIddict reads its applications from the database. So, on every start, a small class brings the database in line with the code. Here is the core of `Server/ApplicationRegistrar.cs`:

```csharp
foreach (var descriptor in configured)
{
    if (await applicationManager.FindByClientIdAsync(descriptor.ClientId!, cancellationToken) is { } application)
    {
        await applicationManager.UpdateAsync(application, descriptor, cancellationToken);
    }
    else
    {
        await applicationManager.CreateAsync(descriptor, cancellationToken);
    }
}
```

It runs **whatever the seeding setting says**: the clients are configuration, not sample data. And since `UpdateAsync` overwrites the row with the descriptor, changing a redirect URI or a secret in the configuration takes effect on the next start, with nothing to edit in the database by hand.


## The authorize and token endpoints
This is the biggest difference. IdentityServer runs the authorize endpoint itself and calls your login pages. With passthrough, OpenIddict validates the request (client, redirect URI, PKCE, scopes) and then calls **our** action, in `Controllers/Connect/ConnectController.cs`. Here is the authorize endpoint, trimmed to its main path:

```csharp
[HttpGet("connect/authorize")]
[HttpPost("connect/authorize")]
[IgnoreAntiforgeryToken]
public async Task<IActionResult> Authorize()
{
    var request = HttpContext.GetOpenIddictServerRequest()
        ?? throw new InvalidOperationException("The OpenID Connect request cannot be retrieved.");

    var session = await HttpContext.AuthenticateAsync(IdentityConstants.ApplicationScheme);

    if (!session.Succeeded || request.HasPromptValue(PromptValues.Login))
    {
        if (request.HasPromptValue(PromptValues.None))
        {
            return Refuse(Errors.LoginRequired, "The user is not signed in.");
        }

        return Challenge(
            new AuthenticationProperties { RedirectUri = CurrentUrl(without: Parameters.Prompt, PromptValues.Login) },
            IdentityConstants.ApplicationScheme);
    }

    var user = await userManager.GetUserAsync(session.Principal);

    var application = await applicationManager.FindByClientIdAsync(request.ClientId!, HttpContext.RequestAborted);
    var client = await ApplicationInfo.ReadAsync(applicationManager, application!, HttpContext.RequestAborted);

    var identity = await principalFactory.CreateAsync(user!);

    identity.SetScopes(request.GetScopes());
    identity.SetResources(ResourcesOf(client, request.GetScopes()));

    UserPrincipalFactory.SetDestinations(identity);

    return SignIn(new ClaimsPrincipal(identity), OpenIddictServerAspNetCoreDefaults.AuthenticationScheme);
}
```

Let's look at it:
- **`AuthenticateAsync(IdentityConstants.ApplicationScheme)`** reads ASP.NET Identity's cookie. Not signed in? A `Challenge` sends the user to our own login page, which comes back to the same URL.
- **`SetScopes` and `SetResources`** decide what the token grants and its audiences (`aud`). Each scope names the resources it brings, which replaces IdentityServer's API resources.
- **`SignIn(..., OpenIddictServerAspNetCoreDefaults.AuthenticationScheme)`** hands the principal back to OpenIddict, which issues the authorization code.

The real action also handles consent and creates an OpenIddict authorization for the user and the client: with the tokens, that is what IdentityServer called persisted grants.

The token endpoint is shorter, but it carries one rule IdentityServer users often implement in `IProfileService.IsActiveAsync`: an account that is gone or can no longer sign in gets no new tokens.

```csharp
var principal = (await HttpContext.AuthenticateAsync(OpenIddictServerAspNetCoreDefaults.AuthenticationScheme)).Principal
    ?? throw new InvalidOperationException("The authorization code or refresh token cannot be read.");

if (await userManager.FindByIdAsync(principal.GetClaim(Claims.Subject)!) is not { IsDeactivated: false } user
    || !await signInManager.CanSignInAsync(user))
{
    return Refuse(Errors.InvalidGrant, "The token is no longer valid.");
}

var identity = new ClaimsIdentity(principal.Claims, TokenValidationParameters.DefaultAuthenticationType, Claims.Name, Claims.Role);

await principalFactory.RefreshAsync(identity, user);

UserPrincipalFactory.SetDestinations(identity);

return SignIn(new ClaimsPrincipal(identity), OpenIddictServerAspNetCoreDefaults.AuthenticationScheme);
```

OpenIddict has already validated the code or the refresh token; we only decide whether the user still deserves a token. `Refuse` is a small helper that calls `Forbid` on OpenIddict's scheme with an `error` and an `error_description`.


## Decide which claims go where
In OpenIddict, a claim goes into no token unless we say so. Each claim needs a **destination**: the access token, the identity token, both or neither. Here is the heart of `Server/UserPrincipalFactory.cs`:

```csharp
private static IEnumerable<string> GetDestinations(Claim claim, ImmutableArray<string> scopes)
{
    switch (claim.Type)
    {
        case Claims.Subject:
            yield return Destinations.AccessToken;
            yield return Destinations.IdentityToken;
            yield break;

        case Claims.Role:
            yield return Destinations.AccessToken;
            yield break;

        case Claims.Name or Claims.PreferredUsername or Claims.Picture:
            yield return Destinations.AccessToken;

            if (scopes.Contains(Scopes.Profile))
            {
                yield return Destinations.IdentityToken;
            }

            yield break;

        case Claims.Email or Claims.EmailVerified when scopes.Contains(Scopes.Email):
            yield return Destinations.IdentityToken;
            yield break;

        default:
            yield break;
    }
}
```

- **The roles** go into the access token only, because the API's policies read them.
- **The profile and the e-mail** go into the identity token when the scope was granted, because the front end shows them.
- **Everything else**, ASP.NET Identity's security stamp among them, stays in the authorization code and the refresh token, which only this server reads.

The same factory builds the claims at every sign-in and rebuilds them at every refresh, so a role taken away is gone at the next refresh.

> **_Note:_**  If your API's policies expect one `scope` claim per scope, be aware that this server's access tokens carry `scope` as one space-separated string (RFC 9068). The API and the identity host in this code base split it into one claim per scope before their policies read it.


## Share the keys across replicas
IdentityServer's key management stores keys for you. OpenIddict expects you to give it credentials. Development and ephemeral keys are not an option in production: ephemeral keys differ between replicas and lose every refresh token on a restart, and development certificates live in a user's certificate store.

The answer here is a `ServerKeyRing`, an `IConfigureOptions<OpenIddictServerOptions>` that creates one RSA signing key and one RSA encryption key on first start, and stores them in a `server_keys` table, protected by Data Protection (whose own key ring is in the same database):

```csharp
using var rsa = RSA.Create(KeySize);

context.ServerKeys.Add(new ServerKey
{
    Use = use,
    ProtectedKey = Convert.ToBase64String(protector.Protect(rsa.ExportPkcs8PrivateKey())),
    CreatedAt = timeProvider.GetUtcNow()
});

try
{
    context.SaveChanges();
}
catch (DbUpdateException)
{
    // Another replica stored its key first: that one is everyone's.
    context.ChangeTracker.Clear();
}

stored = context.ServerKeys.AsNoTracking().First(x => x.Use == use);
```

A unique index on `Use` makes the race harmless: two replicas starting together each generate a key, the second insert fails, and both read the first. The key is then added to `options.SigningCredentials` (or `EncryptionCredentials`) as an `RsaSecurityKey`.

Certificates configured under `ServerKeys` take precedence when present. Automatic key rotation is not there yet: the design notes list it as a follow-up.


## Prune the tokens
OpenIddict keeps a row for every token and authorization, and deletes none on its own. Its Quartz.NET job would bring this host two packages and a store, so a hosted service makes the same two calls (`Server/TokenPruning.cs`):

```csharp
public async Task PruneAsync(CancellationToken cancellationToken = default)
{
    await using var scope = scopeFactory.CreateAsyncScope();

    var now = timeProvider.GetUtcNow();

    var tokens = await scope.ServiceProvider.GetRequiredService<IOpenIddictTokenManager>()
        .PruneAsync(now - TokenRetention, cancellationToken);

    var authorizations = await scope.ServiceProvider.GetRequiredService<IOpenIddictAuthorizationManager>()
        .PruneAsync(now - AuthorizationRetention, cancellationToken);

    logger.Pruned(tokens, authorizations);
}
```

It runs every hour, two minutes after start, with both retentions at **14 days**. That figure is not arbitrary: a redeemed refresh token is kept so that a replay of it revokes its whole chain, and that only matters until it expires, after OpenIddict's 14 days. Every replica prunes on its own timer, and that is fine: `PruneAsync` deletes rows matching a fixed condition, so a second run in the same hour finds fewer rows, or none. 👍


## Conclusion
Moving from Duende IdentityServer to OpenIddict is less about the protocol than about ownership. The issuer, the `/connect/*` endpoints, the client IDs, the scopes and the claims stay the same, so the gateway and the API do not notice. What changes is that the login decision, the claims and their destinations become an ordinary controller and a small factory that we read and test like the rest of the code.

The cost is the parts IdentityServer did for us: clients synced from code on every start, keys stored once and shared across replicas, and a pruning job. Each is a few dozen lines, and each comes with a clear reason. Keycloak was the other option, but it means a separate Java container to run, and our own sign-in pages would become Keycloak themes.

This is how the identity host is built in [Blouppy Starter](https://starter.blouppy.com/): an OpenIddict server with its own ASP.NET Identity pages, behind a YARP gateway and in front of an ASP.NET Core API. The [choice of OpenIddict](https://docs.starter.blouppy.com/choices/openiddict/) is explained in its documentation.

*Thanks for reading! 🙂*
