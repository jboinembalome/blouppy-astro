---
templateKey: 'blog-post'
title: 'Moving from Duende IdentityServer to OpenIddict in ASP.NET Core'
date: 2026-05-22T09:00:00.000Z
updated: 2026-11-07T09:00:00.000Z
author: Jimmy Boinembalome
authorimage: /img/jimmy.jpg
category: C#
topic: 'Security'
illustration: 3
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

Duende IdentityServer works well, but it needs a [commercial licence](https://duendesoftware.com/license) in production, and its [Community Edition](https://duendesoftware.com/products/communityedition) only covers small companies. If you ship a product, or a template that other people deploy, you hand that licence question to every user. [OpenIddict](https://documentation.openiddict.com/introduction) is Apache 2.0, runs inside your own ASP.NET Core host and speaks the same protocol.

The clients do not have to notice: if the issuer, the endpoints, the scopes and the claims stay the same, the gateway's OpenID Connect handler and the API's JWT validation keep working. But OpenIddict is lower-level, and several things IdentityServer did for you become your code. This article covers them one by one.


## What changes, concept by concept

| IdentityServer | OpenIddict |
| --- | --- |
| A `Client` | An application, declared with an `OpenIddictApplicationDescriptor` |
| An `ApiScope` | A scope registered with `RegisterScopes`, and resources set on the token |
| The login and consent logic around `/connect/authorize` | Your own controller, called in **passthrough** |
| `IProfileService` | The claims on the `ClaimsIdentity` you sign in, each with a destination |
| Persisted grants | OpenIddict's authorizations and tokens tables |
| Signing credentials and key management | `SigningCredentials` and `EncryptionCredentials` you provide |
| Token cleanup | `PruneAsync` on the token and authorization managers |



## Register the server
The server uses two packages, `OpenIddict.AspNetCore` and `OpenIddict.EntityFrameworkCore`. With the [EF Core integration](https://documentation.openiddict.com/integrations/entity-framework-core), OpenIddict's applications, authorizations, scopes and tokens live in the same `DbContext` as the [ASP.NET Core Identity](https://learn.microsoft.com/aspnet/core/security/authentication/identity) tables, through one call to `builder.UseOpenIddict()` in `OnModelCreating`.

Then register the server (abridged from the Starter's `Server/ServiceCollectionExtensions.cs`):

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
            .SetEndSessionEndpointUris("connect/endsession"); // revocation, introspection and userinfo likewise

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

Three points matter for a migration:
- **`SetIssuer`** must give the issuer the API already trusts. OpenIddict adds a trailing slash to it, in discovery and in every token's `iss`.
- **`DisableAccessTokenEncryption`** is the line you will look for first. OpenIddict [encrypts access tokens by default](https://documentation.openiddict.com/configuration/encryption-and-signing-credentials), and an API that validates JWTs with ASP.NET Core's JWT handler cannot read an encrypted one.
- **The passthrough calls** let OpenIddict validate each request, then hand it to your own controller.


## Declare the clients in code
IdentityServer clients are often a list of `Client` objects in code. Keep it that way: each one becomes an `OpenIddictApplicationDescriptor`. Here is the gateway's:

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
    Requirements = { Requirements.Features.ProofKeyForCodeExchange }
    // Settings: short access and identity token lifetimes.
};

descriptor.Permissions.UnionWith(
[
    Permissions.Endpoints.Authorization,
    Permissions.Endpoints.Token,
    // ... end session and revocation
    Permissions.GrantTypes.AuthorizationCode,
    Permissions.GrantTypes.RefreshToken,
    Permissions.ResponseTypes.Code,
    Permissions.Scopes.Profile,
    Permissions.Scopes.Email,
    Permissions.Prefixes.Scope + ApiResource,
    Permissions.Prefixes.Scope + IdentityApiResource
]);
```

What a `Client` said with `AllowedGrantTypes` and `AllowedScopes`, OpenIddict says with [permissions](https://documentation.openiddict.com/configuration/application-permissions): one per endpoint, grant type, response type and scope. The client ID, the secret and the redirect URIs stay what the gateway already sends, so its handler does not change.

OpenIddict reads applications from the database, so on every start an `ApplicationRegistrar` calls `FindByClientIdAsync`, then `UpdateAsync(application, descriptor)` or `CreateAsync(descriptor)`. It runs whatever the seeding setting says (clients are configuration, not sample data), and a changed redirect URI or secret takes effect on the next start.


## The authorize and token endpoints
This is the biggest difference. IdentityServer runs the authorize endpoint itself and calls your login pages. With passthrough, OpenIddict validates the request (client, redirect URI, PKCE, scopes) and then calls **your** action. Here is the authorize endpoint, trimmed to its main path (consent and `max_age` left out):

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

    if (await userManager.GetUserAsync(session.Principal) is not { IsDeactivated: false } user)
    {
        await signInManager.SignOutAsync();

        return Challenge(new AuthenticationProperties { RedirectUri = CurrentUrl() }, IdentityConstants.ApplicationScheme);
    }

    var application = await applicationManager.FindByClientIdAsync(request.ClientId!, HttpContext.RequestAborted)
        ?? throw new InvalidOperationException("The application of a validated request cannot be found.");
    var client = await ApplicationInfo.ReadAsync(applicationManager, application, HttpContext.RequestAborted);

    var identity = await principalFactory.CreateAsync(user);

    identity.SetScopes(request.GetScopes());
    identity.SetResources(ResourcesOf(client, request.GetScopes()));

    UserPrincipalFactory.SetDestinations(identity);

    return SignIn(new ClaimsPrincipal(identity), OpenIddictServerAspNetCoreDefaults.AuthenticationScheme);
}
```

- **`AuthenticateAsync(IdentityConstants.ApplicationScheme)`** reads ASP.NET Identity's cookie; without it, a `Challenge` sends the user to your own login page and back.
- **`SetScopes` and `SetResources`** decide what the token grants and its audiences (`aud`), which replaces IdentityServer's API resources.
- **`SignIn(...)`** on OpenIddict's scheme hands the principal back, and OpenIddict issues the code.

The real action also creates an OpenIddict authorization for the user and the client: with the tokens, IdentityServer's persisted grants.

The token endpoint carries a rule that IdentityServer users often implement in `IProfileService.IsActiveAsync`: an account that is gone or can no longer sign in gets no new tokens. OpenIddict has already validated the code or the refresh token, so the action only authenticates OpenIddict's scheme to read the principal, refuses with `invalid_grant` when `userManager.FindByIdAsync(...)` finds no active user or `signInManager.CanSignInAsync(user)` is false, then rebuilds the claims with `principalFactory.RefreshAsync(identity, user)` and signs in again. `Refuse` is a small helper that calls `Forbid` on OpenIddict's scheme with an `error` and an `error_description`.


## Decide which claims go where
In OpenIddict, a claim goes into no token unless you say so: each claim needs a [destination](https://documentation.openiddict.com/configuration/claim-destinations), the access token, the identity token, both or neither. Here is the core of `UserPrincipalFactory` (trimmed):

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

Roles go into the access token, for the API's policies; the profile and e-mail into the identity token when the scope was granted, for the front end. Everything else, including ASP.NET Identity's security stamp, stays in the code and the refresh token, which only this server reads. The factory rebuilds the claims at every refresh, so a removed role is gone at the next one.

> **_Note:_** If your API's policies expect one `scope` claim per scope, note that these access tokens carry `scope` as one space-separated string, as [RFC 9068](https://datatracker.ietf.org/doc/html/rfc9068) specifies. The API splits it into one claim per scope before its policies read it.


## Share the keys across replicas
OpenIddict expects you to provide the keys IdentityServer managed for you. Ephemeral keys differ between replicas and lose every refresh token on a restart; development certificates live in a user's certificate store. Neither fits production.

The Starter's answer is a `ServerKeyRing`, an `IConfigureOptions<OpenIddictServerOptions>` that creates one RSA signing key and one RSA encryption key on first start (`RSA.Create`, then `ExportPkcs8PrivateKey()`). It stores them in a `server_keys` table, protected by Data Protection, whose own key ring is in the same database, and adds them to `SigningCredentials` and `EncryptionCredentials` as `RsaSecurityKey`s.

Two replicas starting together each generate a key. A unique index on `Use` makes the race harmless: the second `SaveChanges` throws a `DbUpdateException`, the replica clears its change tracker and reads the stored key, so both use the first. Certificates configured under `ServerKeys` take precedence when present; automatic rotation of the stored keys is listed as a follow-up in the Starter's design notes.


## Prune the tokens
OpenIddict keeps a row for every [token and authorization](https://documentation.openiddict.com/configuration/token-storage) and deletes none on its own. Its Quartz.NET integration would bring this host two packages and a store, so a hosted service, `TokenPruning`, makes the same two calls: `IOpenIddictTokenManager.PruneAsync(now - TokenRetention)` and `IOpenIddictAuthorizationManager.PruneAsync(now - AuthorizationRetention)`.

It runs hourly on a `PeriodicTimer`, two minutes after start, with both retentions at **14 days**: a redeemed refresh token is kept so that a replay revokes its whole chain, which only matters until it expires, after OpenIddict's default 14 days. Each replica prunes on its own timer, which is safe: `PruneAsync` deletes rows matching a fixed condition, so a second run finds fewer rows, or none.


## Conclusion
Moving from Duende IdentityServer to OpenIddict is less about the protocol than about ownership. The issuer, the endpoints, the client IDs, the scopes and the claims stay the same, so the gateway and the API do not notice. The login decision and the claims become an ordinary controller and a small factory you test like the rest of the code. The cost is what IdentityServer did for you: client sync, a shared key ring and a pruning job, each a few dozen lines. Keycloak was the other option, at the price of a separate Java container and sign-in pages rewritten as Keycloak themes.

The identity host of [Blouppy Starter](https://starter.blouppy.com/) is built this way, behind a YARP gateway and in front of an ASP.NET Core API.


## References

- [Creating your own server instance](https://documentation.openiddict.com/guides/getting-started/creating-your-own-server-instance) and the [EF Core integration](https://documentation.openiddict.com/integrations/entity-framework-core) — OpenIddict: registering the server and its stores.
- [Application permissions](https://documentation.openiddict.com/configuration/application-permissions) and [claim destinations](https://documentation.openiddict.com/configuration/claim-destinations) — OpenIddict: what a client may do and which claim goes into which token.
- [Encryption and signing credentials](https://documentation.openiddict.com/configuration/encryption-and-signing-credentials) and [token storage](https://documentation.openiddict.com/configuration/token-storage) — OpenIddict: keys, access token encryption, stored tokens.
- [Introduction to Identity on ASP.NET Core](https://learn.microsoft.com/aspnet/core/security/authentication/identity) — Microsoft Learn: the accounts and the sign-in cookie.
- [RFC 9068](https://datatracker.ietf.org/doc/html/rfc9068) — the JWT profile for OAuth 2.0 access tokens.
- [Duende licensing](https://duendesoftware.com/license) and [Community Edition](https://duendesoftware.com/products/communityedition) — the licence terms behind the move.
- [OpenIddict for identity](https://docs.starter.blouppy.com/choices/openiddict/) and [Identity architecture](https://docs.starter.blouppy.com/architecture/identity/) — Blouppy Starter's documentation of the choice and the host.
