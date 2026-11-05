---
templateKey: 'blog-post'
title: 'SSO and SCIM 2.0 for a B2B SaaS in ASP.NET Core'
date: 2026-10-13T09:00:00.000Z
author: Jimmy Boinembalome
authorimage: /img/jimmy.jpg
category: C#
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

Enterprise customers ask two questions. "Can our people sign in with Okta, Entra ID or Google Workspace?" And: "when someone leaves, can they lose access the same afternoon, without anybody opening your admin page?" The first one is **single sign-on**, the second one is **provisioning**, and its standard is **SCIM 2.0**.

You can buy both as a service. But with Microsoft's own OpenID Connect handler, a DNS lookup and a few controllers, ASP.NET Core can do it alone.

In this article, we will see verified domains through a DNS TXT record, one OIDC connection per organization added at runtime, the sign-in flow, a SCIM endpoint with its own token, deactivation, privacy and plans.


## Why it is harder than a sign-in button
GitHub and Google are two authentication handlers registered at startup from configuration. An organization's provider is different:
- **It is added at runtime**, any day, without a restart and on every replica.
- **A provider speaks only for its own addresses.** A provider asserting any e-mail could sign in as anyone (the _nOAuth_ class of attack), so an organization proves its domains first.
- **Leaving has to stop everything that acts as the person**: the browser session, the personal access tokens, the membership, the teams. Without erasing an account the person may still want back.

In the code base this comes from, all of it lives in the identity host (`Blouppy.Identity`, on OpenIddict). Memberships stay in the API, reached through integration events.


## Proving a domain with a DNS TXT record
An organization claims `acme.com`, gets a random challenge, and publishes it as a TXT record:

```text:clipboard=false
_blouppy-challenge.acme.com.  TXT  "blouppy-domain-verification=<challenge>"
```

The challenge is 32 random bytes, base64url (`SsoDomainRules.ChallengeBytes`), and a pending claim expires after 14 days. It is published, so it is not a secret.

Before that, `SsoDomainName.TryNormalize` gives the domain its one form: IDNA ASCII, lower case, at least two labels, never an IP address or `*.acme.com`. It is **exact**: `acme.com` never stands for `eu.acme.com`. Public mail domains (`gmail.com` and friends) are refused with their subdomains, from `SsoDomainOptions.DefaultPublicEmailDomains`.

### .NET has no TXT lookup
`System.Net.Dns` resolves addresses, not TXT records. So the lookup is a port, `IDnsTxtResolver`, with an adapter `DnsClientTxtResolver` on DnsClient.NET. Here is its heart:

```csharp
// Absolute, so no resolver configuration can append a search domain to it.
var absoluteName = name.EndsWith('.') ? name : name + ".";

IDnsQueryResponse response;

try
{
    response = await dnsQuery.QueryAsync(absoluteName, QueryType.TXT, QueryClass.IN, cancellationToken);
}
catch (Exception exception) when (exception is DnsResponseException or SocketException
                                      || exception is OperationCanceledException && !cancellationToken.IsCancellationRequested)
{
    return DnsTxtLookup.Unavailable;
}

// A record longer than 255 bytes is several strings, which RFC 7208 §3.3 reads as one.
var values = response.Answers
    .TxtRecords()
    .Select(record => string.Concat(record.Text))
    .ToArray();

return DnsTxtLookup.Answered(values);
```

The important distinction: **a timeout is not "record not found"**. A failure becomes `503 ssoDomain.dnsUnavailable` (retry), an answer without the value `400 ssoDomain.recordNotFound` (check your DNS). The resolvers are those of `Dns:Resolvers` (1.1.1.1 and 8.8.8.8 by default), never the container's, with no cache.

Then `VerifyAsync` compares the values:

```csharp
var lookup = await dnsTxtResolver.ResolveAsync(domain.RecordName, cancellationToken);

if (!lookup.IsAnswered)
{
    return new SsoDomainResult(SsoDomainOutcome.DnsUnavailable, domain);
}

// Exact and case-sensitive: the challenge is base64url, and a record is copied, never retyped.
if (!lookup.Values.Any(value => string.Equals(value.Trim(), domain.RecordValue, StringComparison.Ordinal)))
{
    return new SsoDomainResult(SsoDomainOutcome.RecordNotFound, domain);
}

domain.MarkVerified(now);

if (!await unitOfWork.TryCommitAsync(cancellationToken))
{
    return new SsoDomainResult(SsoDomainOutcome.VerifiedElsewhere);
}
```

Why can the commit fail? Two organizations may verify the same domain at the same moment. A **unique index on `domain` filtered on `status = 'Verified'`** settles that race.

## One OIDC scheme per organization, at runtime
A connection is one row per organization: issuer, client id, protected secret, scopes, the e-mail claim, a default role (`Viewer` or `Member`, never `Admin`) and a `version` raised by every change.

The trick is to decorate `IAuthenticationSchemeProvider`. Here is `SsoSchemeProvider`:

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

- Any other name goes to the inner provider: GitHub and Google are untouched.
- `ISsoConnectionLookup` is a per-replica cache of one minute.
- `IOptionsMonitorCache<OpenIdConnectOptions>` keeps named options forever, so a new version evicts them.
- `GetAllSchemesAsync` just delegates: a connection is **never listed**, so no login button per customer.

The named options come from an `IConfigureNamedOptions<OpenIdConnectOptions>`, `SsoOpenIdConnectOptions`:

```csharp
oidc.Authority = connection.Issuer;
oidc.ClientId = connection.ClientId;
oidc.ClientSecret = connection.ClientSecret;
oidc.UsePkce = true;
oidc.CallbackPath = SsoConnectionRules.CallbackPathOf(connectionId);
oidc.SignInScheme = IdentityConstants.ExternalScheme;
oidc.Backchannel = httpClientFactory.CreateClient(SsoConnectionRules.HttpClientName);
```

The `Backchannel` matters: the issuer is a URL an administrator typed, so discovery and the code exchange go through the SSRF-guarded client ([SSRF-proof outgoing HTTP calls](https://www.blouppy.com/blog/2026-07-09-ssrf-proof-outgoing-http-calls-in-dotnet/) covers it). Entra ID's `common`, `organizations` and `consumers` issuers are refused, since they would accept any tenant's users.

One last piece: ASP.NET Core only asks the schemes registered **at startup** whether a request is their callback. So `SsoCallbackMiddleware`, placed before `UseAuthentication()`, matches `/sso/{id}/signin-oidc` and calls the connection's `IAuthenticationRequestHandler.HandleRequestAsync()`.


## The sign-in flow
### Finding the provider
There are three doors:
- **On the login page, from the e-mail.** `/sso/discover?email=` is rate-limited and answers the same empty object for an unknown domain and an inactive one.
- **From the app.** The Angular SPA sits behind a [BFF gateway](https://www.blouppy.com/blog/2026-05-10-keep-the-access-token-out-of-the-browser-bff-angular-yarp/), and its `UseSsoLogin` middleware redirects `/bff/login?sso={connectionId}` to the connection's start page on the identity host. The person comes back through `/bff/login`, whose session is then there.
- **From the provider's dashboard tile**, which points at `/sso/{id}/start`: OIDC has no IdP-initiated flow, so the tile starts an ordinary sign-in.

### Linking and just-in-time provisioning
When the provider answers, `SsoSignInService.SignInAsync` runs, in order:
1. **The e-mail must be in one of the organization's verified domains**, or the sign-in is refused.
2. **Find the account by the connection's login** (`sso-{id}` and the provider's `sub`), not by e-mail, which can change at the provider.
3. **Else find it by e-mail and link it.** An unconfirmed one loses its password and other logins (`ManagedAccounts.ClaimAsync`).
4. **Else create it**, just in time: e-mail confirmed, no password, no personal organization.
5. **Make the member**, by publishing `SsoMemberProvisionedIntegrationEventDto` with the connection's default role.

Here are steps 1 and 2:

```csharp
// The provider speaks for the domains its organization proved, and for nothing else (nOAuth).
if (!await IsInVerifiedDomainAsync(connection.OrganizationId, email, cancellationToken))
{
    return SsoSignInResult.Refused(SsoSignInRefusal.EmailOutsideVerifiedDomains);
}

// By the provider's subject, not the e-mail, which can change on the provider's side.
var user = await userManager.FindByLoginAsync(scheme, providerUserId);
var existing = user ?? await userManager.FindByEmailAsync(email);
```

The membership is an event because the identity host does not own it, and since it is checked on every sign-in, a failure heals at the next one. 👍

There is no extra second factor after an SSO sign-in: MFA is the provider's job. But an SSO session lasts **24 hours at most** (`SsoManagedSessionValidator.HasEnded`, asked before a refresh): without SCIM, that is how someone removed at the provider stops reaching the app.

### Enforcement and the owner's fallback
Once SSO is required, every account in a verified domain signs in only through the provider: password, GitHub and Google are refused (kept, not deleted). A contractor with another address is unchanged. And **the owner keeps their password with two-factor**: requiring SSO is refused until they have it (`ssoConnection.ownerWithoutTwoFactor`), so a misconfigured provider cannot lock everyone out.


## The SCIM 2.0 endpoint
SCIM is the provider calling **us**: create this user, rename that one, set `active: false`. There is one base URL for every organization, `https://<gateway>/scim/v2`, which the gateway forwards to the identity host with a plain YARP route, `ScimRoute`. A provider has no session: the bearer is kept, and `WithTransformRequestHeaderRemove("Cookie")` makes sure a browser's session never reaches the identity host this way.

### The token says which organization
The token is `blp_scim_` followed by 32 random bytes, shown once and stored as its SHA-256. At most two are live, so it can be rotated without a gap. `ScimTokenAuthenticationHandler` turns it into a principal:

```csharp
var token = await scimTokenService.AuthenticateAsync(header[BearerPrefix.Length..].Trim(), Context.RequestAborted);

if (token is null)
{
    return AuthenticateResult.Fail("The SCIM token is unknown, revoked, or its organization's plan no longer allows SSO.");
}

var identity = new ClaimsIdentity(
    [
        new Claim(ScimRules.OrganizationIdClaim, token.OrganizationId.ToString(System.Globalization.CultureInfo.InvariantCulture)),
        new Claim(ScimRules.TokenIdClaim, token.Id)
    ],
    Scheme.Name);
```

- The principal carries the organization and **no subject**: it is the organization's provider, not a person.
- The token is looked up by its hash, so there is no timing to compare.
- The rate limit (600 a minute) is partitioned by the hashed `Authorization` header, because the limiter runs before authentication.

`ScimControllerBase` carries `[Authorize(Policy = Policies.Scim)]`, answers `application/scim+json` and stays out of the OpenAPI spec.

### Be lenient with what providers send
Filters are one `attr eq "value"` (`ScimFilter.TryParse`), what Okta and Entra ID send before creating a user. And providers do not all speak the same SCIM. Here is a deactivation, Entra ID style, from the end-to-end suite:

```json
{ "schemas": ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
  "Operations": [{ "op": "Replace", "path": "active", "value": "False" }] }
```

`"Replace"` and the string `"False"` are both accepted; Okta sends a whole-user `PUT` instead. An attribute we do not keep is ignored, never refused.


## Deactivation, not erasure
`active: false` (or `DELETE /Users/{id}`) removes the membership through `SsoMemberDeprovisionedIntegrationEventDto`. For a **managed** account, one whose e-mail is in a verified domain, it also deactivates it. Here is `AccountDeactivationService.DeactivateAsync`:

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

- The new security stamp saves the deactivation and signs the identity host's own cookie out.
- `IBrowserSessions.EndAsync` revokes the gateway's tokens, so its next refresh fails.
- Personal access tokens and MCP connectors are all revoked.

An account outside the verified domains only loses the membership. **The owner cannot be deactivated through SCIM** (`409`), or the provider would remove the fallback. And only the organization that deactivated an account may reactivate it (`DeactivatedByOrganizationId`).

> **_Note:_**  Deactivation is deliberately not erasure. Erasure stays the person's decision, through the [GDPR flow](https://www.blouppy.com/blog/2026-10-07-gdpr-data-export-and-account-erasure/).


## Privacy and plans
An erased account's SCIM users are forgotten, and whoever configured a connection becomes `deleted-user`. A deleted organization takes its connection, domains, tokens and SCIM rows with it, and the accounts its provider deactivated are reactivated, since no other organization may.

SSO and SCIM sit behind one entitlement, `AllowsSso` (verifying a domain is on every plan). Losing it lifts enforcement at the next sign-in, stops the SCIM tokens at once, and keeps the connection as an optional way in.


## Testing it with a real provider
`SingleSignOn.feature` and `ScimProvisioning.feature` run against a Keycloak container in the end-to-end graph, through the real gateway: a first sign-in creates the account and the membership, an address outside the verified domains is refused, and a revoked SCIM token is answered `401` at once.


## What it costs
No SAML; a verified domain is never re-checked; the identity host needs DNS egress on port 53; and the membership arrives over the bus, a moment after the sign-in.


## Conclusion
SSO for a B2B SaaS is not a sign-in button. The provider is added at runtime, so a decorated `IAuthenticationSchemeProvider` builds an `OpenIdConnectHandler` scheme per connection. And a provider must never speak for an address it does not own, so every sign-in starts by checking the e-mail against domains proven with a DNS TXT record.

SCIM is the other half: a hashed per-organization token, a lenient endpoint behind a plain proxy route, and a deactivation that revokes everything without erasing anyone.

This is how single sign-on and SCIM are built in [Blouppy Starter](https://starter.blouppy.com/), on its OpenIddict identity host. The [SSO and SCIM documentation](https://docs.starter.blouppy.com/modules/sso-scim/) goes through the configuration.

*Thanks for reading! 🙂*
