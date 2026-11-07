---
templateKey: 'blog-post'
title: 'SSO and SCIM 2.0 for a B2B SaaS in ASP.NET Core'
date: 2026-10-13T09:00:00.000Z
updated: 2026-11-07T09:00:00.000Z
author: Jimmy Boinembalome
authorimage: /img/jimmy.jpg
category: C#
topic: 'Security'
illustration: 3
categorycolor: bg-purple-100 text-purple-800
featuredpost: true
featuredimage: /img/sso-and-scim-for-a-b2b-saas-in-aspnet-core.jpg
description: >-
  Learn how to let each customer sign in through its own identity provider and provision its people with SCIM 2.0, in ASP.NET Core, with no third-party service.
tags:
  - Development
  - C#
  - ASP.NET Core
  - Security
  - OpenID Connect
---

Enterprise customers ask two questions. "Can our people sign in with Okta, Entra ID or Google Workspace?" And: "when someone leaves, can they lose access the same afternoon, without anyone opening your admin page?" The first is **single sign-on**; the second is **provisioning**, and its standard is [SCIM 2.0](https://datatracker.ietf.org/doc/html/rfc7644).

With Microsoft's own OpenID Connect handler, a DNS lookup and a few controllers, ASP.NET Core can do both without a third-party service. In this article, we will cover verified domains, one OIDC connection per organization added at runtime, the sign-in flow, a SCIM endpoint with its own token, and deactivation.


## Why it is harder than a sign-in button
GitHub and Google are two authentication handlers registered at startup. An organization's provider is different:
- **It is added at runtime**, any day, without a restart and on every replica.
- **A provider speaks only for its own addresses.** A provider that could assert any e-mail could sign in as anyone (the _nOAuth_ class of attack), so an organization proves its domains first.
- **Leaving must stop everything that acts as the person**, without erasing an account the person may still want.

All of it lives in the identity host (`Blouppy.Identity`, on [OpenIddict](https://documentation.openiddict.com/)). Memberships stay in the API and are reached through integration events.


## Proving a domain with a DNS TXT record
An organization claims `acme.com`, gets a random challenge, and publishes it as a TXT record:

```text:clipboard=false
_blouppy-challenge.acme.com.  TXT  "blouppy-domain-verification=<challenge>"
```

The challenge is 32 random bytes in base64url (published, so not a secret), and a pending claim expires after 14 days. `SsoDomainName.TryNormalize` gives the domain one form: IDNA ASCII, lower case, at least two labels, never an IP address or a wildcard. It is **exact**: `acme.com` never stands for `eu.acme.com`. Public mail domains such as `gmail.com` are refused, with their subdomains.

### .NET has no TXT lookup
`System.Net.Dns` resolves addresses, not TXT records. So the lookup is a port, `IDnsTxtResolver`, with an adapter, `DnsClientTxtResolver`, on [DnsClient.NET](https://dnsclient.michaco.net/). It queries the absolute name (with a trailing dot, so no search domain is appended), and turns a `DnsResponseException`, a `SocketException`, a timeout or a server error into `DnsTxtLookup.Unavailable`.

The key distinction: **a timeout is not "record not found"**. A failed lookup becomes `503 ssoDomain.dnsUnavailable` (retry later), an answer without the value `400 ssoDomain.recordNotFound` (check your DNS). The resolvers come from `Dns:Resolvers` (1.1.1.1 and 8.8.8.8 by default), never the container's, with no cache. A record longer than 255 bytes is several strings, joined into one as [RFC 7208 §3.3](https://datatracker.ietf.org/doc/html/rfc7208#section-3.3) does.

`SsoDomainService.VerifyAsync` then compares the values exactly and case-sensitively (the challenge is copied, never retyped), marks the domain verified and commits. The commit can fail: two organizations may verify the same domain at the same moment, and a **unique index on `domain` filtered on `status = 'Verified'`** settles that race (`VerifiedElsewhere`).


## One OIDC scheme per organization, at runtime
A connection is one row per organization: issuer, client id, protected secret, scopes, e-mail claim, a default role (`Viewer` or `Member`, never `Admin`) and a `version` raised by every change.

The trick is to decorate [`IAuthenticationSchemeProvider`](https://learn.microsoft.com/dotnet/api/microsoft.aspnetcore.authentication.iauthenticationschemeprovider). Here is `SsoSchemeProvider`:

```csharp
public async Task<AuthenticationScheme?> GetSchemeAsync(string name)
{
    if (!SsoConnectionRules.TryGetConnectionId(name, out var connectionId))
    {
        return await inner.GetSchemeAsync(name);
    }

    var connection = await lookup.GetAsync(connectionId);

    if (connection is null)
    {
        return null;
    }

    // The options are cached by name for the process's life: a newer version of the connection rebuilds them.
    if (versions.Swap(name, connection.Version) != connection.Version)
    {
        optionsCache.TryRemove(name);
    }

    return new AuthenticationScheme(name, connection.DisplayName, typeof(OpenIdConnectHandler));
}
```

Any other name goes to the inner provider, so GitHub and Google are untouched. `ISsoConnectionLookup` is a one-minute cache per replica, and since `IOptionsMonitorCache<OpenIdConnectOptions>` keeps named options forever, a new version evicts them. `GetAllSchemesAsync` delegates to the inner provider: a connection is **never listed**, so there is no login button per customer.

The named options come from `SsoOpenIdConnectOptions`, an `IConfigureNamedOptions<OpenIdConnectOptions>` (excerpt):

```csharp
oidc.Authority = connection.Issuer;
oidc.ClientId = connection.ClientId;
oidc.ClientSecret = connection.ClientSecret;
oidc.ResponseType = OpenIdConnectResponseType.Code;
oidc.ResponseMode = OpenIdConnectResponseMode.Query;
oidc.UsePkce = true;
oidc.CallbackPath = SsoConnectionRules.CallbackPathOf(connectionId);
oidc.SignInScheme = IdentityConstants.ExternalScheme;
oidc.Backchannel = httpClientFactory.CreateClient(SsoConnectionRules.HttpClientName);
```

The `Backchannel` matters: the issuer is a URL an administrator typed, so [discovery](https://openid.net/specs/openid-connect-discovery-1_0.html) and the code exchange go through the SSRF-guarded client (see [SSRF-proof outgoing HTTP calls](https://www.blouppy.com/blog/2026-07-09-ssrf-proof-outgoing-http-calls-in-dotnet/)). Entra ID's `common`, `organizations` and `consumers` [issuers](https://learn.microsoft.com/entra/identity-platform/v2-protocols-oidc) are refused, since they would accept any tenant's users.

ASP.NET Core only asks the schemes registered **at startup** whether a request is their callback. So `SsoCallbackMiddleware`, placed before `UseAuthentication()`, matches `/sso/{id}/signin-oidc` and calls the connection's `IAuthenticationRequestHandler.HandleRequestAsync()`.


## The sign-in flow
### Finding the provider
- **From the e-mail on the login page**: `/sso/discover?email=` is rate-limited and returns the same empty object for an unknown domain and an inactive one.
- **From the app**: the [BFF gateway](https://www.blouppy.com/blog/2026-05-10-keep-the-access-token-out-of-the-browser-bff-angular-yarp/) redirects `/bff/login?sso={connectionId}` to the connection's start page.
- **From the provider's dashboard tile**, pointing at `/sso/{id}/start`: OIDC has no IdP-initiated flow, so the tile starts an ordinary sign-in.

### Linking and just-in-time provisioning
When the provider answers, `SsoSignInService.SignInAsync` runs, in order:
1. **The e-mail must be in one of the organization's verified domains**, or the sign-in is refused.
2. **Find the account by the connection's login** (`sso-{id}` and the provider's `sub`), not by e-mail, which can change at the provider.
3. **Otherwise, find it by e-mail and link it.** An unconfirmed account loses its password and other logins.
4. **Otherwise, create it** just in time: e-mail confirmed, no password.
5. **Make the member** by publishing `SsoMemberProvisionedIntegrationEventDto` with the connection's default role.

The membership is checked on every sign-in, so a failed event heals at the next one. MFA is the provider's job, but an SSO session lasts **24 hours at most** (`SsoManagedSessionValidator`, asked before a refresh): without SCIM, that is how someone removed at the provider stops reaching the app.

### Enforcement and the owner's fallback
Once SSO is required, every account in a verified domain signs in only through the provider: password, GitHub and Google are refused (but kept). A contractor with another address is unaffected. **The owner keeps their password with two-factor**: requiring SSO is refused until they have it (`ssoConnection.ownerWithoutTwoFactor`), so a misconfigured provider cannot lock everyone out.


## The SCIM 2.0 endpoint
SCIM is the provider calling **us**: create this user, rename that one, set `active: false`. There is one base URL for every organization, `https://<gateway>/scim/v2`, which the gateway forwards to the identity host with a plain YARP route. A provider has no session: the bearer is kept, and a [request transform](https://learn.microsoft.com/aspnet/core/fundamentals/servers/yarp/transforms), `WithTransformRequestHeaderRemove("Cookie")`, ensures a browser's session never reaches the identity host this way.

### The token names the organization
The token is `blp_scim_` followed by 32 random bytes, shown once and stored as its SHA-256. At most two are live, so it can be rotated without a gap. `ScimTokenAuthenticationHandler` looks it up by its hash (so there is no comparison to time) and builds a principal with two claims, the organization id and the token id, and **no subject**: it is the organization's provider, not a person.

The rate limit (600 requests a minute) is partitioned by the hashed `Authorization` header, because the limiter runs before authentication. `ScimControllerBase` requires `[Authorize(Policy = Policies.Scim)]`, answers `application/scim+json` and stays out of the OpenAPI spec.

### Be lenient with what providers send
[Filters](https://datatracker.ietf.org/doc/html/rfc7644#section-3.4.2.2) are limited to one `attr eq "value"`, which is what Okta and Entra ID send before creating a user. Providers do not all speak the same SCIM. Here is a deactivation, Entra ID style, as a [PATCH](https://datatracker.ietf.org/doc/html/rfc7644#section-3.5.2):

```json
{ "schemas": ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
  "Operations": [{ "op": "Replace", "path": "active", "value": "False" }] }
```

`"Replace"` and the string `"False"` are both accepted, Okta's whole-user `PUT` too, and an attribute we do not keep is ignored, never refused.


## Deactivation, not erasure
`active: false` (or `DELETE /Users/{id}`) removes the membership through `SsoMemberDeprovisionedIntegrationEventDto`. A **managed** account, one whose e-mail is in a verified domain, is also deactivated by `AccountDeactivationService.DeactivateAsync`:

```csharp
if (!user.IsDeactivated)
{
    user.Deactivate(organizationId, timeProvider.GetUtcNow());
}

EnsureSucceeded(await userManager.UpdateSecurityStampAsync(user));

await browserSessions.EndAsync(user.Id, cancellationToken);
await personalAccessTokenService.RevokeAllAsync(user.Id, cancellationToken);
await mcpConnectorService.RevokeAllAsync(user.Id, cancellationToken);
```

The new security stamp saves the deactivation and signs the identity host's own cookie out; `IBrowserSessions.EndAsync` revokes the gateway's tokens, so its next refresh fails; personal access tokens and MCP connectors are revoked. An account outside the verified domains only loses the membership. **The owner cannot be deactivated through SCIM** (`409`), and only the organization that deactivated an account may reactivate it. Erasure stays the person's decision, through the [GDPR flow](https://www.blouppy.com/blog/2026-10-07-gdpr-data-export-and-account-erasure/).


## Privacy, plans and testing
An erased account's SCIM users are forgotten, and a deleted organization takes its connection, domains, tokens and SCIM rows with it, reactivating the accounts its provider deactivated. SSO and SCIM sit behind one entitlement, `AllowsSso` (domain verification is on every plan): losing it lifts enforcement at the next sign-in and stops the SCIM tokens at once.

`SingleSignOn.feature` and `ScimProvisioning.feature` run against a Keycloak container in the end-to-end graph, through the real gateway: a first sign-in creates the account and the membership, an address outside the verified domains is refused, and a revoked SCIM token gets a `401` at once.

The limits: no SAML, a verified domain is never re-checked, the identity host needs DNS egress on port 53, and the membership arrives over the bus a moment after the sign-in.


## Conclusion
SSO for a B2B SaaS is not a sign-in button: a decorated `IAuthenticationSchemeProvider` builds an `OpenIdConnectHandler` scheme per connection at runtime, and every sign-in checks the e-mail against domains proven by DNS. SCIM adds a hashed per-organization token, a lenient endpoint behind a plain proxy route, and a deactivation that revokes everything without erasing anyone.

This is how single sign-on and SCIM work in [Blouppy Starter](https://starter.blouppy.com/); the [SSO and SCIM documentation](https://docs.starter.blouppy.com/modules/sso-scim/) covers the configuration.

## References
- [RFC 7644: SCIM Protocol (IETF)](https://datatracker.ietf.org/doc/html/rfc7644) — endpoints, filtering and PATCH operations.
- [RFC 7643: SCIM Core Schema (IETF)](https://datatracker.ietf.org/doc/html/rfc7643) — the User resource and its `active` attribute.
- [OpenID Connect Core 1.0](https://openid.net/specs/openid-connect-core-1_0.html) — the authorization code flow and the `sub` claim.
- [OpenID Connect Discovery 1.0](https://openid.net/specs/openid-connect-discovery-1_0.html) — how an issuer's configuration is fetched.
- [Configure OpenID Connect web authentication in ASP.NET Core (Microsoft Learn)](https://learn.microsoft.com/aspnet/core/security/authentication/configure-oidc-web-authentication) — `OpenIdConnectHandler` and its options.
- [`IAuthenticationSchemeProvider` (Microsoft Learn)](https://learn.microsoft.com/dotnet/api/microsoft.aspnetcore.authentication.iauthenticationschemeprovider) — the interface the connection provider decorates.
- [OpenID Connect on the Microsoft identity platform (Microsoft Learn)](https://learn.microsoft.com/entra/identity-platform/v2-protocols-oidc) — Entra ID issuers and tenants.
- [YARP request and response transforms (Microsoft Learn)](https://learn.microsoft.com/aspnet/core/fundamentals/servers/yarp/transforms) — removing the cookie on the SCIM route.
- [RFC 7636: PKCE (IETF)](https://datatracker.ietf.org/doc/html/rfc7636) — the proof key enabled with `UsePkce`.
- [RFC 7208 §3.3 (IETF)](https://datatracker.ietf.org/doc/html/rfc7208#section-3.3) — multiple strings in one TXT record.
- [DnsClient.NET](https://dnsclient.michaco.net/) — the DNS library behind the TXT lookup.
- [OpenIddict documentation](https://documentation.openiddict.com/) — the identity host's OAuth 2.0 and OIDC server.
- [Blouppy Starter documentation: SSO and SCIM](https://docs.starter.blouppy.com/modules/sso-scim/) — configuration and provider guides.
