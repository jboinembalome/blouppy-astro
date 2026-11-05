---
templateKey: 'blog-post'
title: 'Keep the access token out of the browser: a BFF for Angular with ASP.NET Core and YARP'
date: 2026-11-05T09:00:00.000Z
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

Most Angular applications that call a protected API do the same thing: they sign the user in with OpenID Connect, receive an access token (and often a refresh token), and keep it somewhere JavaScript can read, in memory or in `localStorage`. It works, but any script running in the page can read that token too, including an injected one. And a stolen refresh token outlives the session it came from.

The **Backend-for-Frontend** (BFF) pattern takes a different approach: the browser never sees a token. It only holds an HTTP-only cookie, and a small server-side gateway keeps the tokens, attaches the access token to API calls and refreshes it.

In this article, we will build that gateway with **ASP.NET Core** and **YARP**, using only the framework's own pieces (no BFF library), and connect an **Angular** application to it.


## Prerequisites
Before to start you will need:
- The [.NET 10 SDK](https://dotnet.microsoft.com/download/dotnet/10.0).
- An OpenID Connect server where you can register a confidential client using the authorization code flow, with the `offline_access` scope allowed (OpenIddict, Keycloak, Microsoft Entra ID...).
- An ASP.NET Core API that already validates JWT bearer tokens from that server.
- An Angular application.

> **_Note:_**  The API does not change at all in this article. It keeps validating bearer tokens exactly as it does today. 🙂


## What is a BFF?
A BFF is a server that sits between the browser and everything else. For an Angular application, it has three jobs:

1. **It serves the application and the API from one origin.** The browser talks to a single address, so there is no CORS to configure.
2. **It holds the session.** The OpenID Connect flow runs on the server. The tokens are stored in an encrypted cookie that JavaScript cannot read.
3. **It forwards API calls.** When a request for `/api/...` arrives with the session cookie, the gateway takes the access token out of the session and sends the call to the API with an `Authorization: Bearer` header.

```text:clipboard=false
Browser ──cookie──> Gateway ──Bearer token──> API
                       │
                       └──OpenID Connect──> Identity server
```

An injected script can still act inside the page while it is open, but it cannot carry a token away. That is the whole point.


## Create the gateway
Let's create an empty ASP.NET Core project and add **YARP** and the **OpenID Connect** handler:

```powershell
dotnet new web --name Gateway --framework net10.0
cd Gateway
dotnet add package Yarp.ReverseProxy
dotnet add package Microsoft.AspNetCore.Authentication.OpenIdConnect
```


## Configure the session
The session is made of two authentication handlers that come with ASP.NET Core: the **cookie** handler, which stores the session, and the **OpenID Connect** handler, which signs the user in.

```csharp
using Microsoft.AspNetCore.Authentication.Cookies;
using Microsoft.AspNetCore.Authentication.OpenIdConnect;
using Microsoft.IdentityModel.Protocols.OpenIdConnect;

var builder = WebApplication.CreateBuilder(args);

builder.Services
    .AddAuthentication(options =>
    {
        options.DefaultScheme = CookieAuthenticationDefaults.AuthenticationScheme;
        options.DefaultChallengeScheme = CookieAuthenticationDefaults.AuthenticationScheme;
    })
    .AddCookie(options =>
    {
        options.Cookie.Name = "__Host-gateway";
        options.Cookie.HttpOnly = true;
        options.Cookie.SecurePolicy = CookieSecurePolicy.Always;
        options.Cookie.SameSite = SameSiteMode.Strict;
        options.ExpireTimeSpan = TimeSpan.FromHours(8);
        options.SlidingExpiration = true;

        // An API call without a session gets a 401, not a redirect to a login page.
        options.Events.OnRedirectToLogin = context =>
        {
            context.Response.StatusCode = StatusCodes.Status401Unauthorized;
            return Task.CompletedTask;
        };
    })
    .AddOpenIdConnect(OpenIdConnectDefaults.AuthenticationScheme, options =>
    {
        options.Authority = builder.Configuration["Oidc:Authority"];
        options.ClientId = builder.Configuration["Oidc:ClientId"];
        options.ClientSecret = builder.Configuration["Oidc:ClientSecret"];
        options.ResponseType = OpenIdConnectResponseType.Code;
        options.UsePkce = true;

        // Keep the access and refresh tokens in the session cookie.
        options.SaveTokens = true;
        options.Scope.Add("offline_access");
        options.Scope.Add("api");

        options.MapInboundClaims = false;
        options.GetClaimsFromUserInfoEndpoint = true;
    });

builder.Services.AddAuthorization();
```

Let's look at the cookie options, because they carry most of the security:
- `HttpOnly`: JavaScript cannot read the cookie. This is what keeps the tokens out of reach of a script.
- `SameSite = Strict`: the browser does not send the cookie on a request started from another site.
- The `__Host-` prefix: the browser only accepts the cookie if it is `Secure`, has no `Domain` and is set on the path `/`. Nobody can plant it from a sub-domain.

The OpenID Connect handler is a **confidential client**: it has a client secret, which is only possible because it runs on the server. With `SaveTokens = true`, the tokens it receives are stored in the authentication properties, and therefore in the encrypted cookie.

> **_Note:_**  The default challenge scheme is the cookie, not OpenID Connect. This way, an unauthenticated call to `/api` gets a **401** that Angular can handle, instead of a redirect that an `HttpClient` call cannot follow. We will start the sign-in explicitly, from a dedicated endpoint.


## Forward the API calls with YARP
Now let's add YARP. The configuration has two routes: `/api/...` goes to the API and requires a session, and everything else goes to the Angular application.

```json
"ReverseProxy": {
  "Routes": {
    "api": {
      "ClusterId": "api",
      "AuthorizationPolicy": "default",
      "Match": { "Path": "/api/{**catch-all}" }
    },
    "spa": {
      "ClusterId": "spa",
      "Match": { "Path": "{**catch-all}" }
    }
  },
  "Clusters": {
    "api": {
      "Destinations": { "api": { "Address": "https://localhost:5001" } }
    },
    "spa": {
      "Destinations": { "spa": { "Address": "http://localhost:4200" } }
    }
  }
}
```

> **_Note:_**  `"AuthorizationPolicy": "default"` tells YARP to apply the default authorization policy, which requires an authenticated user. Without a session, the request never reaches the API.

The interesting part is the **transform**: before forwarding a call to the API, we read the access token from the session and put it in the `Authorization` header. We also remove the `Cookie` header, since the API has no use for the session cookie.

```csharp
using System.Net.Http.Headers;
using Microsoft.AspNetCore.Authentication;
using Yarp.ReverseProxy.Transforms;

builder.Services
    .AddReverseProxy()
    .LoadFromConfig(builder.Configuration.GetSection("ReverseProxy"))
    .AddTransforms(context =>
    {
        if (context.Route.RouteId != "api")
            return;

        context.AddRequestHeaderRemove("Cookie");
        context.AddRequestTransform(async transformContext =>
        {
            var accessToken = await transformContext.HttpContext.GetTokenAsync("access_token");

            transformContext.ProxyRequest.Headers.Authorization =
                new AuthenticationHeaderValue("Bearer", accessToken);
        });
    });
```

`GetTokenAsync` reads the token from the current session. The API receives an ordinary bearer token and does not know a gateway exists.


## Add the endpoints for Angular
Angular needs three things from the gateway: a way to sign in, a way to sign out, and a way to know who is signed in.

```csharp
using System.Security.Claims;

var app = builder.Build();

app.UseAuthentication();
app.UseAuthorization();

app.MapGet("/bff/login", () =>
    Results.Challenge(
        new AuthenticationProperties { RedirectUri = "/" },
        [OpenIdConnectDefaults.AuthenticationScheme]));

app.MapPost("/bff/logout", () =>
    Results.SignOut(
        new AuthenticationProperties { RedirectUri = "/" },
        [CookieAuthenticationDefaults.AuthenticationScheme, OpenIdConnectDefaults.AuthenticationScheme]));

app.MapGet("/bff/user", (ClaimsPrincipal user) =>
    user.Identity?.IsAuthenticated == true
        ? Results.Ok(new
        {
            Name = user.FindFirstValue("name"),
            Email = user.FindFirstValue("email"),
        })
        : Results.Unauthorized());

app.MapReverseProxy();

app.Run();
```

- `/bff/login` starts the OpenID Connect flow. The browser **navigates** to it: it is a full page redirect to the identity server, and back.
- `/bff/logout` removes the session cookie and signs the user out of the identity server.
- `/bff/user` returns the claims Angular needs to display, never the tokens.

> **_Note:_**  `MapReverseProxy` comes last: the `/bff/...` endpoints are matched before the `{**catch-all}` route of the Angular application.


## Protect against CSRF
Here is the trade-off of a cookie: the browser sends it automatically. If another site could make the browser call `/api/...`, the call would carry the session.

`SameSite = Strict` already blocks most of it, but the usual extra protection for a BFF is simple: **every API call must carry a custom header**. A cross-site HTML form cannot add a header, and a cross-site script cannot either, because a custom header triggers a CORS preflight that our gateway never accepts.

```csharp
app.Use(async (context, next) =>
{
    var isApiCall = context.Request.Path.StartsWithSegments("/api");

    if (isApiCall && context.Request.Headers["X-CSRF"] != "1")
    {
        context.Response.StatusCode = StatusCodes.Status403Forbidden;
        return;
    }

    await next(context);
});
```

> **_Note:_**  Add this middleware before `MapReverseProxy`. If you stream server-sent events through the gateway, the stream's route needs an exception: a browser `EventSource` cannot send a custom header.


## Refresh the access token
An access token is short-lived (15 minutes is common), but the session lasts 8 hours. The gateway has to refresh the token before it expires, without Angular knowing anything about it.

The cookie handler gives us the right hook: `OnValidatePrincipal` runs on every request that carries the session. With `SaveTokens = true`, the session also stores `expires_at`, so we can refresh the token when it is about to expire:

```csharp
options.Events.OnValidatePrincipal = async context =>
{
    var expiresAt = context.Properties.GetTokenValue("expires_at");
    var refreshToken = context.Properties.GetTokenValue("refresh_token");

    if (expiresAt is null || refreshToken is null)
        return;

    if (DateTimeOffset.Parse(expiresAt) > DateTimeOffset.UtcNow.AddMinutes(1))
        return;

    var httpClient = context.HttpContext.RequestServices
        .GetRequiredService<IHttpClientFactory>()
        .CreateClient();

    var response = await httpClient.PostAsync(
        $"{builder.Configuration["Oidc:Authority"]}/connect/token",
        new FormUrlEncodedContent(new Dictionary<string, string>
        {
            ["grant_type"] = "refresh_token",
            ["refresh_token"] = refreshToken,
            ["client_id"] = builder.Configuration["Oidc:ClientId"]!,
            ["client_secret"] = builder.Configuration["Oidc:ClientSecret"]!,
        }));

    if (!response.IsSuccessStatusCode)
    {
        // The identity server refused the refresh: the session is over.
        context.RejectPrincipal();
        await context.HttpContext.SignOutAsync();
        return;
    }

    var tokens = await response.Content.ReadFromJsonAsync<JsonElement>();

    context.Properties.UpdateTokenValue("access_token", tokens.GetProperty("access_token").GetString()!);
    // Some servers rotate the refresh token, others keep the same one.
    if (tokens.TryGetProperty("refresh_token", out var newRefreshToken))
        context.Properties.UpdateTokenValue("refresh_token", newRefreshToken.GetString()!);

    context.Properties.UpdateTokenValue("expires_at",
        DateTimeOffset.UtcNow.AddSeconds(tokens.GetProperty("expires_in").GetInt32()).ToString("o"));

    // Write the new tokens back into the cookie.
    context.ShouldRenew = true;
};
```

This snippet needs `using System.Text.Json;` for `JsonElement`, and the `HttpClient` factory registered with `builder.Services.AddHttpClient();`.

> **_Note:_**  `/connect/token` is the token endpoint of OpenIddict. With another server, read the `token_endpoint` from its discovery document. This version is deliberately short: in production, you also want to make sure that two requests arriving at the same time do not refresh the same session twice, since many servers rotate the refresh token on each use.


## Connect Angular
The Angular side becomes simpler than before: no OAuth library, no token storage, no `Authorization` header to add.

First, an interceptor adds the `X-CSRF` header to every call to the gateway:

```typescript
import { HttpInterceptorFn } from '@angular/common/http';

export const csrfInterceptor: HttpInterceptorFn = (request, next) =>
  request.url.startsWith('/')
    ? next(request.clone({ setHeaders: { 'X-CSRF': '1' } }))
    : next(request);
```

```typescript
export const appConfig: ApplicationConfig = {
  providers: [
    provideHttpClient(withInterceptors([csrfInterceptor])),
  ],
};
```

Then a small service knows who is signed in. Sign in is a navigation, because it leaves the application for the identity server:

```typescript
@Injectable({ providedIn: 'root' })
export class SessionService {
  private readonly _httpClient = inject(HttpClient);

  getUser(): Observable<User | null> {
    return this._httpClient.get<User>('/bff/user').pipe(
      catchError(() => of(null)),
    );
  }

  login(): void {
    window.location.href = '/bff/login';
  }
}
```

And sign out is a simple form, so that the browser follows the redirects to the identity server and back:

```html
<form method="post" action="/bff/logout">
  <button type="submit">Sign out</button>
</form>
```

> **_Note:_**  The logout form does not carry the `X-CSRF` header, which is why `/bff/logout` is outside the `/api` check. It is still protected: the cookie is `SameSite=Strict`, so a form posted from another site arrives without a session.

Finally, the API calls use **relative paths**, since the gateway serves the application and the API from the same origin:

```typescript
this._httpClient.get<Project[]>(`/api/v1/workspaces/${workspaceId}/projects`);
```

During development, open the gateway's address, not `ng serve`'s: the gateway forwards everything that is not `/api` or `/bff` to the Angular dev server.


## Before going to production
A few points that this minimal version leaves out:
- **The cookie's encryption keys.** The session cookie is protected by ASP.NET Core Data Protection. If the keys stay on one machine, a restart or a second replica signs everyone out. Persist them in a shared store, for example with `PersistKeysToDbContext` from `Microsoft.AspNetCore.DataProtection.EntityFrameworkCore`.
- **The cookie's size.** The tokens are in the cookie. If they grow too large, store the session server-side with the cookie handler's `SessionStore` option and keep only a key in the cookie.
- **Revocation on logout.** Signing out removes the cookie, but the refresh token is still valid until it expires. Call the identity server's revocation endpoint in `/bff/logout`.
- **Clients that are not a browser.** Mobile apps and scripts do not need the gateway. They can keep calling the API with a bearer token, since the API did not change.


## Conclusion
With a BFF, the Angular application never holds a token. The browser has an HTTP-only, `SameSite=Strict` cookie, and the gateway does the rest: it runs the OpenID Connect flow, attaches the access token to API calls, refreshes it and protects the API against CSRF with a single header.

As we have seen, everything comes from ASP.NET Core itself: the cookie handler, the OpenID Connect handler and YARP. There is no BFF library to learn, which means that changing the gateway's behaviour is changing ordinary middleware. The cost is one more service to run, and one more hop on each API call.

If you would like to see this gateway in a complete application, with the shared Data Protection keys, the single refresh per session, the revocation on logout and the event stream already wired, it is how [Blouppy Starter](https://starter.blouppy.com/) is built: an Angular application behind a YARP gateway, in front of an ASP.NET Core API and an OpenIddict identity server. The [gateway's documentation](https://docs.starter.blouppy.com/architecture/gateway/) explains each of these choices.

*Thanks for reading! 🙂*
