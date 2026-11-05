---
templateKey: 'blog-post'
title: 'Keep the access token out of the browser: a BFF for Angular with ASP.NET Core and YARP'
date: 2026-05-10T09:00:00.000Z
author: Jimmy Boinembalome
authorimage: /img/jimmy.jpg
category: C#
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

Most Angular applications that call a protected API sign the user in with OpenID Connect, receive an access token (often a refresh token too), and keep it where JavaScript can read it, in memory or in `localStorage`. It works, but any script in the page can read that token too, including an injected one. And a stolen refresh token outlives the session it came from.

The **Backend-for-Frontend** (BFF) pattern takes a different approach: the browser never sees a token. It only holds an HTTP-only cookie, and a small server-side gateway keeps the tokens, attaches the access token to API calls and refreshes it.

In this article, we will build that gateway with **ASP.NET Core** and **YARP**, using only the framework's own pieces (no BFF library), and connect an **Angular** application to it.


## Prerequisites
Before to start you will need:
- The [.NET 10 SDK](https://dotnet.microsoft.com/download/dotnet/10.0).
- An OpenID Connect server where you can register a confidential client using the authorization code flow, with the `offline_access` scope allowed (OpenIddict, Keycloak, Microsoft Entra ID...).
- An ASP.NET Core API that already validates JWT bearer tokens from that server.
- An Angular application.

> **_Note:_**  The API does not change at all: it keeps validating bearer tokens as it does today. 🙂


## What is a BFF?
A BFF is a server that sits between the browser and everything else. For an Angular application, it has three jobs:

1. **It serves the application and the API from one origin**, so there is no CORS to configure.
2. **It holds the session.** The OpenID Connect flow runs on the server, and the tokens live in an encrypted cookie JavaScript cannot read.
3. **It forwards API calls.** A call to `/api/...` arrives with the cookie and leaves for the API with an `Authorization: Bearer` header.

```text:clipboard=false
Browser ──cookie──> Gateway ──Bearer token──> API
                       │
                       └──OpenID Connect──> Identity server
```

An injected script can still act inside the open page, but it cannot carry a token away. That is the whole point.


## Create the gateway
Let's create an empty ASP.NET Core project and add **YARP** and the **OpenID Connect** handler:

```powershell
dotnet new web --name Gateway --framework net10.0
cd Gateway
dotnet add package Yarp.ReverseProxy
dotnet add package Microsoft.AspNetCore.Authentication.OpenIdConnect
```


## Configure the session
The session is made of two ASP.NET Core handlers: the **cookie** handler, which stores the session, and the **OpenID Connect** handler, which signs the user in. Each scheme has its own name (`SessionSchemes.Cookie` is `"gateway-session"`, `SessionSchemes.OpenIdConnect` is `"identity"`):

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

The cookie options carry most of the security:
- `HttpOnly`: JavaScript cannot read the cookie, nor the tokens inside.
- `SameSite = Strict`: the cookie is not sent on a request started from another site.
- The `__Host-` prefix: the cookie is only accepted if `Secure`, without `Domain`, on `/`. Nobody can plant it from a sub-domain.

The OpenID Connect handler is a **confidential client**, with a secret, which is only possible on a server. With `SaveTokens = true`, the access token, the refresh token and `expires_at` are stored in the encrypted cookie.

> **_Note:_**  The challenge scheme is OpenID Connect, so `/bff/login` simply returns a challenge. An API call never reaches it: without a session, the gateway answers **401** itself, which `HttpClient` can handle, unlike a redirect.


## Forward the API calls with YARP
YARP's configuration needs **one** route: everything goes to the Angular application's own server (`ng serve`, or nginx in production), without the `Cookie` header, which that server has no use for:

```json
"Routes": {
  "spa": {
    "ClusterId": "spa",
    "Match": { "Path": "/{**catch-all}" },
    "Transforms": [ { "RequestHeaderRemove": "Cookie" } ]
  }
},
"Clusters": {
  "spa": {
    "Destinations": { "spa": { "Address": "https://localhost:4201" } }
  }
}
```

The APIs are mapped in code, with YARP's **direct forwarding**: `MapForwarder` maps an ordinary endpoint that forwards to a destination, so we can attach our own metadata to it:

```csharp
public static IEndpointConventionBuilder MapRemoteApi(
    this IEndpointRouteBuilder endpoints,
    PathString path,
    string destinationPrefix,
    bool requireAntiforgeryHeader = true)
    => endpoints
        .MapForwarder($"{path}/{{**rest}}", destinationPrefix, WithAccessToken)
        .WithMetadata(new RemoteApiMetadata(requireAntiforgeryHeader));

private static void WithAccessToken(TransformBuilderContext context)
{
    context.UseDefaultForwarders = false;
    context.AddXForwarded(ForwardedTransformActions.Set);
    context.AddRequestHeaderRemove("Cookie");
    context.AddRequestTransform(transform =>
    {
        if (transform.HttpContext.Items[AccessTokenItem] is string accessToken)
            transform.ProxyRequest.Headers.Authorization = new AuthenticationHeaderValue("Bearer", accessToken);

        return ValueTask.CompletedTask;
    });
}
```

- The session cookie never leaves the gateway.
- `X-Forwarded-*` headers are **set**, not appended, so a client cannot slip in its own address.
- The transform takes the token from `HttpContext.Items`: a transform cannot answer the request, and without a token we want a 401. So the token is fetched **before** the endpoint runs.


## Check the header and fetch the token
Here is the trade-off of a cookie: the browser sends it automatically. `SameSite = Strict` already blocks most cross-site requests, but the usual extra protection for a BFF is simple: **every call must carry a custom header**, `X-CSRF: 1`. A cross-site form cannot add a header, and a cross-site `fetch` that tries triggers a CORS preflight that the gateway never accepts. `AntiforgeryHeader.IsPresent(request)` checks exactly that.

Let's write the middleware that runs before a remote API's endpoint, reading the metadata we attached:

```csharp
public static IApplicationBuilder UseRemoteApiAccessTokens(this IApplicationBuilder app)
    => app.Use(async (context, next) =>
    {
        if (context.GetEndpoint()?.Metadata.GetMetadata<RemoteApiMetadata>() is not { } remoteApi)
        {
            await next(context);
            return;
        }

        if (remoteApi.RequireAntiforgeryHeader && !AntiforgeryHeader.IsPresent(context.Request))
        {
            context.Response.StatusCode = StatusCodes.Status401Unauthorized;
            return;
        }

        var accessToken = await context.RequestServices.GetRequiredService<UserAccessTokens>().GetAsync(context);

        if (accessToken is null)
        {
            context.Response.StatusCode = StatusCodes.Status401Unauthorized;
            return;
        }

        context.Items[AccessTokenItem] = accessToken;

        await next(context);
    });
```

`GetEndpoint()` only returns something after `UseRouting`, so this middleware goes **between** `UseRouting` and the endpoints. Without the header or without a session, the answer is **401** and the API never sees the call.

> **_Note:_**  A browser `EventSource` cannot send a custom header, so a server-sent events stream is mapped with `requireAntiforgeryHeader: false`. That is acceptable for a read-only `GET` whose frames only signal "re-read", behind a `SameSite=Strict` cookie.


## Refresh the access token, one refresh at a time
An access token is short-lived (15 minutes here), but the session lasts 8 hours. The gateway refreshes the token **on demand**, in `UserAccessTokens.GetAsync`, when a call is about to be forwarded:

```csharp
public async Task<string?> GetAsync(HttpContext context)
{
    var session = await context.AuthenticateAsync(SessionSchemes.Cookie);

    if (!session.Succeeded || session.Properties is not { } properties)
        return null;

    var accessToken = properties.GetTokenValue("access_token");

    if (accessToken is not null && ExpiresAt(properties) - timeProvider.GetUtcNow() > TimeSpan.FromMinutes(1))
        return accessToken;

    if (properties.GetTokenValue("refresh_token") is not { } refreshToken)
        return null;

    var refreshed = await RefreshOnceAsync(refreshToken, context.RequestAborted);

    if (refreshed is null)
    {
        await context.SignOutAsync(SessionSchemes.Cookie);
        return null;
    }

    properties.UpdateTokenValue("access_token", refreshed.AccessToken);
    properties.UpdateTokenValue("refresh_token", refreshed.RefreshToken ?? refreshToken);
    properties.UpdateTokenValue("expires_at", refreshed.ExpiresAt.ToString("o", CultureInfo.InvariantCulture));

    await context.SignInAsync(SessionSchemes.Cookie, session.Principal!, properties);

    return refreshed.AccessToken;
}
```

A token with less than a minute left is refreshed, and `SignInAsync` rewrites the cookie on the response of that call. Some servers rotate the refresh token, others keep it, hence `refreshed.RefreshToken ?? refreshToken`.

Now the important part. A page sends several calls at once, all with the **same** refresh token. If each refreshes and the server rotates refresh tokens, all but one present a used token, and a strict server revokes the session. So only the first call refreshes:

```csharp
private async Task<RefreshedTokens?> RefreshOnceAsync(string refreshToken, CancellationToken cancellationToken)
{
    var key = Hash(refreshToken);

    if (cache.TryGetValue<RefreshedTokens>(key, out var shared))
        return shared;

    var gate = _locks.GetOrAdd(key, _ => new SemaphoreSlim(1, 1));

    await gate.WaitAsync(cancellationToken);

    try
    {
        if (cache.TryGetValue(key, out shared))
            return shared;

        var refreshed = await RefreshAsync(refreshToken, cancellationToken);

        if (refreshed is not null)
            cache.Set(key, refreshed, TimeSpan.FromMinutes(1));

        return refreshed;
    }
    finally
    {
        gate.Release();
        _locks.TryRemove(key, out _);
    }
}
```

- `_locks` is a `ConcurrentDictionary<string, SemaphoreSlim>`: one gate per refresh token (hashed with SHA-256), so two sessions never wait for each other.
- The answer is kept a minute in an `IMemoryCache`, so the calls that waited, and those arriving just after with the old cookie, take it.
- The lock is per process: two replicas refreshing at the same moment are left to the identity server's refresh-token reuse leeway.

`RefreshAsync` is a plain `refresh_token` grant. It takes the token endpoint from the discovery document the OpenID Connect handler already loaded, authenticates with `client_secret_basic`, and goes through the handler's `Backchannel`. A refusal returns `null`, and the session is signed out.


## Add the endpoints for Angular
Angular needs three things from the gateway: a way to sign in, a way to sign out, and a way to know who is signed in.

```csharp
endpoints.MapGet("/bff/login", (HttpContext context, string? returnUrl) =>
{
    var target = AppPath(returnUrl);

    if (target is null)
        return Results.BadRequest();

    return context.User.Identity?.IsAuthenticated == true
        ? Results.LocalRedirect(target)
        : Results.Challenge(new AuthenticationProperties { RedirectUri = target }, [SessionSchemes.OpenIdConnect]);
});
```

`/bff/login` is a **navigation**: a full page redirect to the identity server, and back where the user was. `AppPath` keeps the `returnUrl` to a path of the application (no absolute URL, no `//host`), otherwise the login would be an open redirect.

Signing out is a navigation too, a `GET`. Any link to it, even one pasted inside the application, would sign someone out, so the URL carries the session's `sid` claim, and a logout that does not name the current session is refused:

```csharp
endpoints.MapGet("/bff/logout", async (HttpContext context, UserAccessTokens tokens, string? sid) =>
{
    if (context.User.Identity?.IsAuthenticated != true)
        return Results.LocalRedirect("/");

    if (context.User.FindFirst("sid")?.Value is { } sessionId && sessionId != sid)
        return Results.BadRequest();

    await tokens.RevokeRefreshTokenAsync(context);

    return Results.SignOut(
        new AuthenticationProperties { RedirectUri = "/" },
        [SessionSchemes.Cookie, SessionSchemes.OpenIdConnect]);
});
```

Before removing the cookie, `RevokeRefreshTokenAsync` posts the refresh token to the server's `revocation_endpoint`, so a copied cookie is worth nothing after sign-out. A failed revocation is logged and the logout goes on.

Finally, `/bff/user` is a `fetch`, so it requires `X-CSRF` too. It returns the session's claims as `{ type, value }` pairs, never a token, plus `bff:logout_url`: `/bff/logout?sid=...`.


## Wire the pipeline
Here is the order:

```csharp
app.UseAuthentication();
app.UseRouting();
app.UseRemoteApiAccessTokens();
app.UseAuthorization();

app.MapSessionEndpoints(); // the three /bff endpoints
app.MapRemoteApi("/api/v1/events", apiUrl, requireAntiforgeryHeader: false);
app.MapRemoteApi("/api", apiUrl);
app.MapReverseProxy();         // the SPA's catch-all, matched last
```


## Connect Angular
The Angular side gets simpler: no OAuth library, no token storage, no `Authorization` header. API calls use **relative paths**, and an interceptor adds `X-CSRF` to every request:

```typescript
export const csrfHeaderInterceptor: HttpInterceptorFn = (req, next) =>
  next(req.clone({ withCredentials: true, headers: req.headers.set('X-CSRF', '1') }));
```

Then a service turns `/bff/user` into signals. Signing in and out are navigations:

```typescript
@Injectable({ providedIn: 'root' })
export class AuthService {
  private readonly _httpClient = inject(HttpClient);
  private session$: Observable<Session> | null = null;

  public session: Signal<Session> = toSignal(defer(() => this.getSession()), { initialValue: null });
  public logoutUrl = computed(() => this.session()?.find(c => c.type === 'bff:logout_url')?.value ?? null);

  public getSession(ignoreCache = false): Observable<Session> {
    if (!this.session$ || ignoreCache) {
      this.session$ = this._httpClient.get<Session>('bff/user').pipe(
        catchError(() => of(null)),
        shareReplay(1)
      );
    }
    return this.session$;
  }

  public signIn(returnUrl = `${window.location.pathname}${window.location.search}`): void {
    window.location.href = `/bff/login?returnUrl=${encodeURIComponent(returnUrl)}`;
  }

  public signOut(): void {
    const logoutUrl = this.logoutUrl();

    if (logoutUrl) {
      window.location.href = logoutUrl;
    }
  }
}

export type Session = { type: string; value: string }[] | null;
```

The sign-out link comes from the server, `sid` included: Angular never builds it.

Last, a **401** from the API means the session may have expired, or only that call was refused. The error interceptor calls `AuthService.handleUnauthorized()`, which re-reads `/bff/user` **once** however many calls fail together, and sends the user to sign in only if the session is really gone. It skips `bff/` requests: for an anonymous visitor, a 401 from `/bff/user` is the answer, not an expiry.

During development, open the gateway's address, not `ng serve`'s: the gateway forwards the rest to the Angular dev server.


## Before going to production
A few points that matter beyond a single machine:
- **The cookie's encryption keys.** The cookie is protected by ASP.NET Core Data Protection. If its keys stay in the container, every redeploy signs everyone out, and two replicas cannot read each other's cookies. Persist them with a fixed name, `AddDataProtection().SetApplicationName("Gateway").PersistKeysToDbContext<GatewayDbContext>()` (`Microsoft.AspNetCore.DataProtection.EntityFrameworkCore`), and encrypt them at rest with a certificate. Changing the name later signs every session out. 😉
- **A Content-Security-Policy.** The gateway is the origin the application loads from, so it sends the policy (`script-src 'self'`, `connect-src 'self'`, `frame-ancestors 'none'`): a script can no longer steal a token, so let's make it hard to inject one.
- **What the browser remembers.** On a successful logout redirect, the gateway can add `Clear-Site-Data: "storage"`, which wipes the origin's storage even for a logout the application never saw (another tab, a bookmark).


## Conclusion
With a BFF, the Angular application never holds a token. The browser has an HTTP-only, `SameSite=Strict` cookie, and the gateway does the rest: it runs the OpenID Connect flow, attaches the access token, refreshes it once however many calls arrive together, revokes it on logout, and guards every cookie call with one header.

Everything comes from ASP.NET Core itself: the cookie handler, the OpenID Connect handler and YARP's direct forwarding. There is no BFF library to learn, so changing the gateway is changing ordinary middleware. The cost is one more service to run, and one more hop on each call.

If you would like to see it in a complete application, with its key ring in PostgreSQL and the event stream already wired, this is how the gateway of [Blouppy Starter](https://starter.blouppy.com/) is built, in front of an ASP.NET Core API and an OpenIddict identity server. The [gateway's documentation](https://docs.starter.blouppy.com/architecture/gateway/) explains each of these choices.

*Thanks for reading! 🙂*
