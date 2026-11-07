---
templateKey: 'blog-post'
title: 'A strict Content Security Policy for an Angular SPA served by ASP.NET Core'
date: 2026-08-26T09:00:00.000Z
updated: 2026-11-07T09:00:00.000Z
author: Jimmy Boinembalome
authorimage: /img/jimmy.jpg
category: C#
topic: 'Security'
illustration: 3
categorycolor: bg-purple-100 text-purple-800
featuredpost: true
featuredimage: /img/strict-content-security-policy-for-an-angular-spa.jpg
description: >-
  Learn how to send a real Content Security Policy from ASP.NET Core in front of an Angular application, and which concessions you cannot avoid.
tags:
  - Development
  - C#
  - ASP.NET Core
  - Angular
  - Security
---

A [Content Security Policy](https://developer.mozilla.org/docs/Web/HTTP/Guides/CSP) (CSP) is the header that tells the browser what a page may load and run. Done well, it turns an injected `<script>` into a console error instead of a breach. Done badly, it is `default-src *`, or a strict policy copied from a blog post that leaves the Angular app blank on the first deploy.

The hard part is knowing which relaxations Angular really forces on us, and how to roll a change out without breaking production. In this article, we will build a small immutable policy type in ASP.NET Core, write the header from a middleware at the front of the pipeline, go through a real policy for an Angular SPA, and see what the front end had to give up to live under it.


## Where the policy has to be sent
The application this comes from serves the Angular bundle through a gateway, a YARP-based BFF with [its own article](https://www.blouppy.com/blog/2026-05-10-keep-the-access-token-out-of-the-browser-bff-angular-yarp/). The browser loads everything from **one origin, the gateway**, so that is where the policy that matters is sent.

The API behind it sends its own, stricter policy. The browser never loads the SPA from the API, but an API response can still render in a tab (the Scalar reference UI, an error page), and neither host should ever be framed by someone else.

Both policies are built from the same pieces in the shared service defaults: an immutable `ContentSecurityPolicy` type, its `ContentSecurityPolicyOptions`, a `ContentSecurityPolicyMiddleware`, and two extension methods, `AddContentSecurityPolicy()` and `UseContentSecurityPolicy()`.

## An immutable policy type
`ContentSecurityPolicy` is an ordered list of directives. Sources are written exactly as they appear in the header, quotes included (`'self'`, `'none'`), so the code reads the way the browser reports a violation. `Create()` starts an empty policy, and `With(directive, params string[] sources)` returns a **new** policy, so the static policy a host declares cannot be mutated at runtime. Declaring a directive twice **appends** to it, which lets configuration widen a policy without replacing it.

Two more methods widen it, `WithAdditionalSources(...)` and `WithReportUri(...)`, and `ToHeaderValue(...)` renders it:

```csharp
public string ToHeaderValue(string? scriptNonce = null)
{
    if (!IsBase64(scriptNonce))
    {
        return _headerValue ??= Render(_directives);
    }

    var index = IndexOf(_directives, ScriptSourceDirective);

    if (index < 0)
    {
        return _headerValue ??= Render(_directives);
    }

    var directives = new List<Directive>(_directives);

    directives[index] = directives[index].Append([$"'nonce-{scriptNonce}'"]);

    return Render(directives);
}
```

- Without a nonce, the value is rendered once and cached in `_headerValue`.
- The nonce is only added when the policy declares `script-src`. Adding it to a policy that falls back to `default-src` would **narrow** what scripts may run instead of widening it.
- A nonce holding anything but base64 characters is dropped. Otherwise a value like `nonce'; script-src *` could close the directive and rewrite the rest of the header.


## The middleware and its options
What a deployment may change lives in `ContentSecurityPolicyOptions`, bound from the `ContentSecurityPolicy` section: `Enabled`, `ReportOnly`, `ReportUri` and `AdditionalSources` (extra sources keyed by directive). The directives themselves are **not** there: each host declares them in code, next to the resources it loads.

```csharp
internal sealed class ContentSecurityPolicyMiddleware(
    RequestDelegate next,
    ContentSecurityPolicyHeader header)
{
    public Task InvokeAsync(HttpContext context)
    {
        context.Response.OnStarting(WriteHeaderAsync, context);

        return next(context);
    }

    private Task WriteHeaderAsync(object state)
    {
        var context = (HttpContext)state;

        var headers = context.Response.Headers;

        if (!headers.ContainsKey(header.Name))
        {
            headers[header.Name] = header.Policy.ToHeaderValue(GetNonce(context));
        }

        return Task.CompletedTask;
    }

    private string? GetNonce(HttpContext context)
        => header.NonceHttpContextItemKey is { } key && context.Items.TryGetValue(key, out var nonce)
            ? nonce as string
            : null;
}
```

The header is written from [`Response.OnStarting`](https://learn.microsoft.com/dotnet/api/microsoft.aspnetcore.http.httpresponse.onstarting) rather than on the way in, for two reasons:
- **A response that already carries a policy keeps it.** The gateway proxies API responses that send their own, stricter policy, and must not replace it with a looser one.
- **The endpoint has run by then**, so a per-request nonce it published in `HttpContext.Items` is available.

`UseContentSecurityPolicy(policy, nonceHttpContextItemKey)` builds the header once, at startup. It does nothing when `Enabled` is false, widens the policy with `WithAdditionalSources(options.AdditionalSources)` and `WithReportUri(options.ReportUri)`, picks [`Content-Security-Policy-Report-Only`](https://developer.mozilla.org/docs/Web/HTTP/Reference/Headers/Content-Security-Policy-Report-Only) when `ReportOnly` is set, and registers the middleware.

## Register it first
The [middleware order](https://learn.microsoft.com/aspnet/core/fundamentals/middleware/) matters: after routing or the exception handler, redirects, 404s and error pages would leave without a policy. Here is the API:

```csharp
// First in the pipeline: the policy is on the redirects, the 404s and the error
// responses too, not only on what reaches a controller.
app.UseContentSecurityPolicy(
    ContentSecurityPolicies.Api,
    nonceHttpContextItemKey: ScalarOptions.NonceHttpContextItemKey);
```

On the gateway, only the client-origin forwarding comes before it, since it touches no response; then `app.UseContentSecurityPolicy(ContentSecurityPolicies.SinglePageApplication)`. Both hosts call `services.AddContentSecurityPolicy(configuration)` to bind the options.


## The gateway policy, line by line
Here is the policy that protects the SPA, in `Blouppy.Gateway/Security/ContentSecurityPolicies.cs`:

```csharp
public static ContentSecurityPolicy SinglePageApplication { get; } = ContentSecurityPolicy.Create()
    .With("default-src", "'self'")
    .With("script-src", "'self'")
    .With("style-src", "'self'", "'unsafe-inline'")
    .With("img-src", "'self'", "data:", "blob:", "https:")
    .With("font-src", "'self'", "data:")
    .With("connect-src", "'self'")
    .With("frame-src", "'self'")
    .With("object-src", "'none'")
    .With("base-uri", "'self'")
    .With("form-action", "'self'")
    .With("frame-ancestors", "'none'");
```

- `default-src 'self'`: anything not listed falls back to the gateway's origin.
- `script-src 'self'`: only the bundle's own `<script src>` files run. No `'unsafe-inline'`, no `'unsafe-eval'`, no CDN. This is the line that stops XSS.
- `style-src 'self' 'unsafe-inline'` and `img-src ... https:`: the two deliberate concessions, explained below.
- `connect-src 'self'`: `fetch`, XHR and `EventSource` only reach the gateway. With a BFF, the API, the session endpoints and the event stream are all on that origin anyway.
- `object-src 'none'` blocks plugins, `base-uri 'self'` stops an injected `<base>` tag from redirecting relative URLs, and `form-action 'self'` keeps forms posting to the gateway.
- `frame-src 'self'` frames nothing third-party, and `frame-ancestors 'none'` keeps the application out of anyone's iframe, which closes clickjacking.

### Why `style-src 'unsafe-inline'`
Angular adds component styles to the document **at runtime**, as `<style>` elements. The [Angular security guide](https://angular.dev/best-practices/security#content-security-policy) offers a nonce through the `ngCspNonce` attribute, but a nonce must be fresh per response and written into the page, and here `index.html` is served unchanged. So the policy allows inline styles. It is a bounded concession: styles execute nothing.

### Why `img-src https:`
Profile pictures come from the GitHub CDN, and the rich-text editor stores whatever image URL a user pastes, which no host list can cover. Images execute nothing either; drop that feature and you can narrow the directive.

> **_Note:_**  `frame-src 'self'` was originally opened for a silent-login iframe, which disappeared when the session moved to ASP.NET Core's cookie and OpenID Connect handlers. Nothing frames a page today, so `'none'` would hold as well.

Everything that can **execute** (scripts, workers, plugins) is limited to one origin; the two wide directives only cover things that cannot run code. [Google's strict CSP guidance](https://web.dev/articles/strict-csp) prefers nonces or hashes with `'strict-dynamic'` over host allowlists; `'self'` alone holds here because the origin serves only the bundle and the BFF endpoints, and no user-uploaded script.


## The stricter API policy
The API answers JSON, so it starts from nothing:

```csharp
public static ContentSecurityPolicy Api { get; } = ContentSecurityPolicy.Create()
    .With("default-src", "'none'")
    .With("script-src", "'self'")
    .With("style-src", "'self'", "'unsafe-inline'")
    .With("img-src", "'self'", "data:")
    .With("font-src", "'self'")
    .With("connect-src", "'self'")
    .With("base-uri", "'none'")
    .With("form-action", "'none'")
    .With("frame-ancestors", "'none'");
```

What it opens is exactly what the [Scalar](https://scalar.com/products/api-references/integrations/aspnetcore/integration) reference UI needs, all served by the API host. Two calls in its `MapScalarApiReference` options make that possible:

```csharp
options
    // A fresh nonce per request lets the inline bootstrap script run under
    // `script-src 'self'` without 'unsafe-inline'.
    .WithNonce()
    // Its default fonts come from Scalar's CDN, which `default-src 'none'` blocks.
    .DisableDefaultFonts();
```

`WithNonce()` makes Scalar generate a nonce per request and publish it in `HttpContext.Items` under `ScalarOptions.NonceHttpContextItemKey`, the key passed to `UseContentSecurityPolicy`. The middleware then appends `'nonce-…'` to `script-src` on that response only. Unlike the SPA's `index.html`, this page is rendered per request, which is why a nonce works here and not there.


## What the front end had to give up
The policy broke one thing in the Angular build: **critical CSS inlining**. With it on, the build inlines the critical CSS and loads the real stylesheet like this:

```html
<link rel="stylesheet" href="styles.css" media="print" onload="this.media='all'">
```

That `onload` is an inline event handler, and `script-src 'self'` blocks it, so the app renders with only the critical CSS. The fix is the [`inlineCritical`](https://angular.dev/reference/configs/workspace-config) option in `front/application/angular.json`:

```json
"optimization": {
  "scripts": true,
  "fonts": true,
  "styles": {
    "minify": true,
    "inlineCritical": false
  }
}
```

It costs a little first-paint time, and `index.html` now carries only same-origin `<link>` and `<script src>` tags. A dead `<link rel="preconnect" href="https://fonts.gstatic.com">` went at the same time, since every font is served from the bundle.

> **_Note:_**  Angular's `security.autoCsp` option is the alternative: the CLI hashes every inline script in `index.html`, critical CSS inlining included, and adds a hash-based policy in a `<meta>` tag. It only covers scripts, and browsers ignore `frame-ancestors` and `report-uri` in a `<meta>` tag, so a header is still needed; this code base keeps a single header policy instead.


## Rolling it out with report-only
A directive change goes in the host's `ContentSecurityPolicies` class, with a comment saying why. An environment can widen it from configuration, without a rebuild:

```json
{
  "ContentSecurityPolicy": {
    "Enabled": true,
    "ReportOnly": false,
    "ReportUri": "",
    "AdditionalSources": {
      "connect-src": ["https://analytics.example"]
    }
  }
}
```

- **Development runs report-only** on both hosts (`appsettings.Development.json` sets `"ReportOnly": true`), because the Angular dev server the gateway proxies has its own live-reload machinery. Every other environment enforces.
- `ReportUri` sends violation reports to a collector; without it, they only show in the browser console. CSP Level 3 deprecates [`report-uri`](https://developer.mozilla.org/docs/Web/HTTP/Reference/Headers/Content-Security-Policy/report-uri) in favour of [`report-to`](https://developer.mozilla.org/docs/Web/HTTP/Reference/Headers/Content-Security-Policy/report-to), but browsers still honour it.
- `Enabled: false` is the break-glass switch, not a configuration choice.

Every change follows the same path: report-only, watch the reports, then enforce.


## How to verify
The policy type and the middleware have unit tests, such as `Should_write_the_policy_on_a_response_the_pipeline_never_reached`, `Should_keep_the_policy_the_response_already_carries` and `Should_ignore_the_nonce_when_it_is_not_a_base64_value`, which feeds it `nonce'; script-src *`.

On the API, an integration test asserts the exact header string on `/api/v1/billing/plans`, and another checks that an unknown route carries it too. By hand, `curl -I https://localhost:5071/` and `curl -I https://localhost:5001/api/v1/billing/plans` show the headers of both hosts; then click through the app with the browser console open, where every violation is logged.


## Conclusion
A strict CSP for an Angular SPA is mostly a matter of being honest about the exceptions: scripts, connections, frames and forms are locked to one origin, while inline styles and images stay open, and neither can execute code. On the server side, a small immutable policy type, a middleware that writes from `OnStarting` without overwriting an existing header, registered first, and a report-only switch are enough to send a policy on every response and change it safely.

This is how the gateway and the API send their policies in [Blouppy Starter](https://starter.blouppy.com/); the [gateway documentation](https://docs.starter.blouppy.com/architecture/gateway/) describes the host the SPA is served from.


## References
- [Content Security Policy Level 3](https://www.w3.org/TR/CSP3/) — the W3C specification.
- [Content Security Policy (CSP) guide](https://developer.mozilla.org/docs/Web/HTTP/Guides/CSP) — MDN's introduction to directives, nonces and reporting.
- [Content-Security-Policy-Report-Only](https://developer.mozilla.org/docs/Web/HTTP/Reference/Headers/Content-Security-Policy-Report-Only) — testing a policy without enforcing it.
- [report-uri](https://developer.mozilla.org/docs/Web/HTTP/Reference/Headers/Content-Security-Policy/report-uri) and [report-to](https://developer.mozilla.org/docs/Web/HTTP/Reference/Headers/Content-Security-Policy/report-to) — the two reporting directives.
- [Angular security: Content security policy](https://angular.dev/best-practices/security#content-security-policy) — what Angular needs, `ngCspNonce` and `autoCsp`.
- [Angular workspace configuration](https://angular.dev/reference/configs/workspace-config) — the `optimization.styles.inlineCritical` option.
- [Mitigate XSS with a strict CSP](https://web.dev/articles/strict-csp) — Google's nonce- and hash-based guidance.
- [OWASP Content Security Policy Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Content_Security_Policy_Cheat_Sheet.html) — directive-by-directive advice.
- [ASP.NET Core middleware](https://learn.microsoft.com/aspnet/core/fundamentals/middleware/) — pipeline order.
- [HttpResponse.OnStarting](https://learn.microsoft.com/dotnet/api/microsoft.aspnetcore.http.httpresponse.onstarting) — running code just before the headers are sent.
- [Scalar for ASP.NET Core](https://scalar.com/products/api-references/integrations/aspnetcore/integration) — the API reference UI and its options.
- [Blouppy Starter: Gateway](https://docs.starter.blouppy.com/architecture/gateway/) — the host that serves the SPA.
