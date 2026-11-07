---
templateKey: 'blog-post'
title: 'Keep the access token out of the browser: a BFF for Angular with ASP.NET Core and YARP'
date: 2026-05-10T09:00:00.000Z
updated: 2026-11-07T09:00:00.000Z
author: Jimmy Boinembalome
authorimage: /img/jimmy.jpg
category: C#
topic: 'Security'
illustration: 2
categorycolor: bg-purple-100 text-purple-800
featuredpost: true
featuredimage: /img/keep-the-access-token-out-of-the-browser.jpg
description: >-
  Learn how to build a Backend-for-Frontend with ASP.NET Core and YARP so that your Angular application never holds an access token.
tags:
  - Development
  - C#
  - ASP.NET Core
  - Angular
  - Security
  - YARP
---

Most Angular applications sign the user in with OpenID Connect and keep the access token (often a refresh token too) where JavaScript can read it, in memory or in `localStorage`. Any script in the page can read it, including an injected one, and a stolen refresh token outlives the session it came from.

The **Backend-for-Frontend** (BFF) pattern, described in [OAuth 2.0 for Browser-Based Applications](https://www.rfc-editor.org/rfc/rfc10017.html#name-backend-for-frontend-bff), takes a different approach: the browser never sees a token. It holds an HTTP-only cookie, and a small server-side gateway keeps the tokens, attaches the access token to API calls and refreshes it.

In this article, we build that gateway with **ASP.NET Core** and **YARP**, without a BFF library, and connect an **Angular** application to it.


## Prerequisites
You need the [.NET 10 SDK](https://dotnet.microsoft.com/download/dotnet/10.0), an Angular application, an OpenID Connect server where you can register a confidential client with `offline_access`, and an API that already validates its JWT bearer tokens. The API does not change. The gateway starts as an empty project with [YARP](https://learn.microsoft.com/aspnet/core/fundamentals/servers/yarp/yarp-overview) and the OpenID Connect handler:

```powershell
dotnet new web --name Gateway --framework net10.0
dotnet add Gateway package Yarp.ReverseProxy
dotnet add Gateway package Microsoft.AspNetCore.Authentication.OpenIdConnect
```


## What is a BFF?
A BFF is a server between the browser and everything else. It serves the application and the API from one origin (no CORS to configure), runs the OpenID Connect flow and keeps the tokens in an encrypted cookie, and forwards each API call with an `Authorization: Bearer` header:

```text:clipboard=false
Browser ──cookie──> Gateway ──Bearer token──> API
                       │
                       └──OpenID Connect──> Identity server
```

An injected script can still act inside the open page, but it cannot carry a token away.

## Configure the session
The [cookie handler](https://learn.microsoft.com/aspnet/core/security/authentication/cookie) stores the session, and the [OpenID Connect handler](https://learn.microsoft.com/aspnet/core/security/authentication/configure-oidc-web-authentication) signs the user in (`SessionSchemes.*` are string constants naming the schemes):

```csharp
builder.Services
    .AddAuthentication(options =>
    {
        options.DefaultScheme = SessionSchemes.Cookie;
        options.DefaultChallengeScheme = SessionSchemes.OpenIdConnect;
        options.DefaultSignOutScheme = SessionSchemes.OpenIdConnect;
    })
    .AddCookie(SessionSchemes.Cookie, options =>
    {
        options.Cookie.Name = "__Host-gateway";
        options.Cookie.SameSite = SameSiteMode.Strict;
        options.Cookie.SecurePolicy = CookieSecurePolicy.Always;
        options.Cookie.HttpOnly = true;
        options.SlidingExpiration = true;
        options.ExpireTimeSpan = TimeSpan.FromHours(8);

        // A call without a session is answered, never redirected: the SPA decides to sign in.
        options.Events.OnRedirectToLogin = context =>
        {
            context.Response.StatusCode = StatusCodes.Status401Unauthorized;

            return Task.CompletedTask;
        };
    })
    .AddOpenIdConnect(SessionSchemes.OpenIdConnect, options =>
    {
        options.SignInScheme = SessionSchemes.Cookie;
        options.Authority = builder.Configuration["Oidc:Authority"];
        options.ClientId = builder.Configuration["Oidc:ClientId"];
        options.ClientSecret = builder.Configuration["Oidc:ClientSecret"];
        options.ResponseType = "code";
        options.UsePkce = true;
        options.GetClaimsFromUserInfoEndpoint = true;
        options.MapInboundClaims = false;
        options.SaveTokens = true;

        options.Scope.Add("email");
        options.Scope.Add("api");
        options.Scope.Add("offline_access");
    });
```

The cookie options carry most of the security (see [`Set-Cookie`](https://developer.mozilla.org/docs/Web/HTTP/Reference/Headers/Set-Cookie)):
- `HttpOnly`: JavaScript cannot read the cookie or the tokens inside.
- `SameSite = Strict`: no cookie on a request started from another site.
- `__Host-`: the cookie must be `Secure`, without `Domain`, on `/`, so no sub-domain can plant it.

The OpenID Connect handler is a **confidential client**, with a secret only a server can keep (in user secrets or a vault, not `appsettings.json`). `SaveTokens = true` stores the tokens and `expires_at` in the encrypted cookie. Without a session, an API call gets a **401**, which `HttpClient` handles, unlike a redirect.


## Forward the API calls with YARP
YARP's configuration needs **one** route: a `/{**catch-all}` to the Angular application's own server (`ng serve`, or nginx in production), with a `RequestHeaderRemove: Cookie` transform, since that server has no use for the cookie.

The APIs are mapped in code with YARP's [direct forwarding](https://learn.microsoft.com/aspnet/core/fundamentals/servers/yarp/direct-forwarding): `MapForwarder` maps an ordinary endpoint, so we can attach our own metadata to it (simplified from the Starter's `RemoteApis.MapRemoteApi`):

```csharp
endpoints
    .MapForwarder($"{path}/{{**rest}}", destinationPrefix, transforms =>
    {
        transforms.UseDefaultForwarders = false;
        transforms.AddXForwarded(ForwardedTransformActions.Set);
        transforms.AddRequestHeaderRemove("Cookie");
        transforms.AddRequestTransform(transform =>
        {
            if (transform.HttpContext.Items[AccessTokenItem] is string accessToken)
            {
                transform.ProxyRequest.Headers.Authorization = new AuthenticationHeaderValue("Bearer", accessToken);
            }

            return ValueTask.CompletedTask;
        });
    })
    .WithMetadata(new RemoteApiMetadata(requireAntiforgeryHeader));
```

The cookie never leaves the gateway, and `X-Forwarded-*` headers are **set**, not appended, so a client cannot slip in its own address. A transform cannot end the request with a 401, so a middleware fetches the token **before** the endpoint runs and leaves it in `HttpContext.Items`.


## Check the header and fetch the token
A cookie is sent automatically, which invites cross-site request forgery. `SameSite = Strict` blocks most of it; on top, every call must carry a [custom header](https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html), `X-CSRF: 1`. A cross-site form cannot add one, and a cross-site `fetch` that tries triggers a CORS preflight the gateway never accepts. A middleware checks the header, then fetches the token (abridged):

```csharp
public static IApplicationBuilder UseRemoteApiAccessTokens(this IApplicationBuilder app)
    => app.Use(async (context, next) =>
    {
        if (context.GetEndpoint()?.Metadata.GetMetadata<RemoteApiMetadata>() is { } remoteApi)
        {
            var accessToken = remoteApi.RequireAntiforgeryHeader && !AntiforgeryHeader.IsPresent(context.Request)
                ? null
                : await context.RequestServices.GetRequiredService<UserAccessTokens>().GetAsync(context);

            if (accessToken is null)
            {
                context.Response.StatusCode = StatusCodes.Status401Unauthorized;

                return;
            }

            context.Items[AccessTokenItem] = accessToken;
        }

        await next(context);
    });
```

`GetEndpoint()` only works after `UseRouting`, so this middleware goes **between** `UseRouting` and the endpoints.

> **_Note:_** A browser `EventSource` cannot send a custom header, so the server-sent events stream is mapped with `requireAntiforgeryHeader: false`: acceptable for a read-only `GET` behind a `SameSite=Strict` cookie.


## Refresh the access token, one refresh at a time
The access token lives 15 minutes, the session 8 hours. `UserAccessTokens.GetAsync` reads the tokens from `context.AuthenticateAsync(SessionSchemes.Cookie)` and returns the access token while it has more than a minute left. Otherwise it refreshes, writes the new tokens back with `properties.UpdateTokenValue(...)` (keeping the old refresh token if the server did not rotate it) and calls `SignInAsync`, which rewrites the cookie on that response. A refused refresh signs the session out.

A page sends several calls at once, all with the **same** refresh token. If each one refreshes and the server rotates refresh tokens, all but one present a used token, and a strict server revokes the session ([RFC 9700](https://datatracker.ietf.org/doc/html/rfc9700) recommends that reuse detection). So only the first call refreshes (abridged):

```csharp
private async Task<RefreshedTokens?> RefreshOnceAsync(string refreshToken, CancellationToken cancellationToken)
{
    var key = Hash(refreshToken);
    var gate = _locks.GetOrAdd(key, _ => new SemaphoreSlim(1, 1));

    await gate.WaitAsync(cancellationToken);

    try
    {
        if (cache.TryGetValue<RefreshedTokens>(key, out var shared))
        {
            return shared;
        }

        var refreshed = await RefreshAsync(refreshToken, cancellationToken);

        if (refreshed is not null)
        {
            cache.Set(key, refreshed, SharedRefreshLifetime);
        }

        return refreshed;
    }
    finally
    {
        gate.Release();
        _locks.TryRemove(key, out _);
    }
}
```

- `_locks` holds one `SemaphoreSlim` per refresh token (hashed with SHA-256), so two sessions never wait for each other.
- The answer stays a minute in an `IMemoryCache`, for the calls that waited and those arriving just after with the old cookie.
- The lock is per process: concurrent refreshes on two replicas rely on the identity server's reuse leeway.

`RefreshAsync` is a plain `refresh_token` grant ([RFC 6749 §6](https://datatracker.ietf.org/doc/html/rfc6749#section-6)) through the OpenID Connect handler's `Backchannel`, with `client_secret_basic`.


## Add the endpoints for Angular
`/bff/login` is a full-page navigation: a `Results.Challenge(...)` on the OpenID Connect scheme that returns to `returnUrl`. An `AppPath` check accepts only a path of the application (no absolute URL, no `//host`), so it cannot be an open redirect.

`/bff/logout` is a `GET` navigation too, so any link to it could sign someone out: the URL carries the session's `sid` claim, and a URL that does not name the current session gets a 400. Before `Results.SignOut` on both schemes, it posts the refresh token to the server's `revocation_endpoint` ([RFC 7009](https://datatracker.ietf.org/doc/html/rfc7009)), so a copied cookie is worth nothing after sign-out. A failed revocation is logged and the logout continues.

`/bff/user`, a `fetch`, requires `X-CSRF` and returns the session's claims as `{ type, value }` pairs, never a token, plus `bff:logout_url`.


## Wire the pipeline
The order matters:

```csharp
app.UseAuthentication();
app.UseRouting();
app.UseRemoteApiAccessTokens();
app.UseAuthorization();

app.MapSessionEndpoints(); // the three /bff endpoints
app.MapRemoteApi("/api/v1/events", apiUrl, requireAntiforgeryHeader: false);
app.MapRemoteApi("/api", apiUrl);
app.MapReverseProxy(); // the SPA's catch-all, matched last
```


## Connect Angular
Angular needs no OAuth library, no token storage and no `Authorization` header. API calls use **relative paths**, and an [interceptor](https://angular.dev/guide/http/interceptors) adds `X-CSRF`:

```typescript
export const csrfHeaderInterceptor: HttpInterceptorFn = (req, next) =>
  next(req.clone({ withCredentials: true, headers: req.headers.set('X-CSRF', '1') }));
```

An `AuthService` turns `/bff/user` into a signal with `toSignal(...)`. Signing in sets `window.location.href` to `/bff/login?returnUrl=...`; signing out navigates to the session's `bff:logout_url`. The sign-out link comes from the server, `sid` included: Angular never builds it.

On a **401** from the API, the error interceptor calls `AuthService.handleUnauthorized()`, which re-reads `/bff/user` **once**, however many calls fail together, and sends the user to sign in only if the session is gone. It skips `bff/` requests, where a 401 is the normal answer for an anonymous visitor.

During development, open the gateway's address, not `ng serve`'s.


## Before going to production
- **Persist the cookie's keys.** [Data Protection](https://learn.microsoft.com/aspnet/core/security/data-protection/configuration/overview) encrypts the cookie; keys left in the container sign everyone out on each redeploy and differ between replicas. Use `AddDataProtection().SetApplicationName("Gateway").PersistKeysToDbContext<GatewayDbContext>()`, encrypt the keys at rest with a certificate, and never change the name afterwards.
- **Send a Content Security Policy** (`script-src 'self'`, `connect-src 'self'`, `frame-ancestors 'none'`): a script can no longer steal a token, so make it hard to inject one.
- **Add [`Clear-Site-Data: "storage"`](https://developer.mozilla.org/docs/Web/HTTP/Reference/Headers/Clear-Site-Data)** to the logout redirect, to wipe the origin's storage even for a logout the application never saw.


## Conclusion
With a BFF, the Angular application never holds a token: the browser has an HTTP-only, `SameSite=Strict` cookie, and the gateway runs the OpenID Connect flow, attaches, refreshes and revokes the tokens, and guards every call with one header. It is ordinary ASP.NET Core and YARP code; the cost is one more service and one more hop per call. The gateway of [Blouppy Starter](https://starter.blouppy.com/) is built this way, as its [gateway documentation](https://docs.starter.blouppy.com/architecture/gateway/) explains.


## References

- [OAuth 2.0 for Browser-Based Applications (RFC 10017)](https://www.rfc-editor.org/rfc/rfc10017.html#name-backend-for-frontend-bff) — the IETF description of the BFF pattern and its threat model.
- [Cookie authentication](https://learn.microsoft.com/aspnet/core/security/authentication/cookie) and [OpenID Connect web authentication](https://learn.microsoft.com/aspnet/core/security/authentication/configure-oidc-web-authentication) — Microsoft Learn: the two handlers that make the session.
- [YARP direct forwarding](https://learn.microsoft.com/aspnet/core/fundamentals/servers/yarp/direct-forwarding) — Microsoft Learn: `MapForwarder` and transforms.
- [ASP.NET Core Data Protection configuration](https://learn.microsoft.com/aspnet/core/security/data-protection/configuration/overview) — Microsoft Learn: persisting and protecting the key ring.
- [RFC 6749 §6](https://datatracker.ietf.org/doc/html/rfc6749#section-6), [RFC 7009](https://datatracker.ietf.org/doc/html/rfc7009) and [RFC 9700](https://datatracker.ietf.org/doc/html/rfc9700) — refreshing, revoking and securing tokens.
- [OWASP CSRF Prevention Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html) — custom request headers and `SameSite` cookies.
- [Set-Cookie](https://developer.mozilla.org/docs/Web/HTTP/Reference/Headers/Set-Cookie) and [Clear-Site-Data](https://developer.mozilla.org/docs/Web/HTTP/Reference/Headers/Clear-Site-Data) — MDN: cookie prefixes and attributes, wiping storage on logout.
- [Angular HTTP interceptors](https://angular.dev/guide/http/interceptors) — angular.dev: functional interceptors.
- [Blouppy Starter: the gateway](https://docs.starter.blouppy.com/architecture/gateway/) and [why a BFF](https://docs.starter.blouppy.com/choices/bff/) — the complete implementation this article comes from.
