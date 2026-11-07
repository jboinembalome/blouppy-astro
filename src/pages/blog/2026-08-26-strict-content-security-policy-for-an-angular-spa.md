---
templateKey: 'blog-post'
title: 'A strict Content Security Policy for an Angular SPA served by ASP.NET Core'
date: 2026-08-26T09:00:00.000Z
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

A **Content Security Policy** (CSP) is the header that tells the browser what a page is allowed to load and run. Done well, it turns an injected `<script>` into a console error instead of a breach. Done badly, it is either `default-src *` (useless) or a strict policy copied from a blog post that leaves the Angular app as a blank page on the first deploy.

The hard part is knowing which relaxations Angular really forces on us, and how to roll a change out without breaking production.

In this article, we will build a small, immutable policy type in ASP.NET Core, write the header from a middleware registered at the front of the pipeline, go through a real policy for an Angular SPA line by line, and see what the front end had to give up to live under it.


## Where the policy has to be sent
The application this comes from serves the Angular bundle through a gateway (a YARP-based BFF, which has [its own article](https://www.blouppy.com/blog/2026-05-10-keep-the-access-token-out-of-the-browser-bff-angular-yarp/)). The browser loads everything from **one origin: the gateway**. That is where the policy that matters is sent.

The API behind it sends its own, much stricter policy. The browser never loads the SPA from the API, but a response from it can still render in a tab: the Scalar reference UI, an error page. And neither host should ever be framed by someone else.

So we need two policies, built from the same pieces: an immutable `ContentSecurityPolicy` type, its `ContentSecurityPolicyOptions`, a `ContentSecurityPolicyMiddleware` and two extension methods, `AddContentSecurityPolicy()` and `UseContentSecurityPolicy()`.

## An immutable policy type
Let's start with the type itself. Sources are written exactly as they appear in the header, quotes included (`'self'`, `'none'`), so the code reads the way the browser reports a violation.

```csharp
public sealed class ContentSecurityPolicy
{
    private readonly List<Directive> _directives;

    private ContentSecurityPolicy(List<Directive> directives)
        => _directives = directives;

    public static ContentSecurityPolicy Create()
        => new([]);

    public ContentSecurityPolicy With(string directive, params string[] sources)
    {
        var directives = new List<Directive>(_directives);

        var index = IndexOf(directives, directive);

        if (index < 0)
        {
            directives.Add(new Directive(directive, [.. sources]));
        }
        else
        {
            directives[index] = directives[index].Append(sources);
        }

        return new ContentSecurityPolicy(directives);
    }

    private sealed record Directive(string Name, string[] Sources)
    {
        public Directive Append(string[] sources)
            => this with { Sources = [.. Sources, .. sources] };
    }
}
```

A few things are worth noticing:
- `With` returns a **new** policy. The host's policy is a static property, so nothing at runtime can mutate it by accident.
- Declaring a directive twice **appends** to it. That is what lets configuration widen a policy without replacing it.

The type also has `WithAdditionalSources(...)`, `WithReportUri(...)` and `ToHeaderValue(string? scriptNonce = null)`. The last one deserves a closer look:

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

- Without a nonce, the rendered value is computed once and cached in `_headerValue`.
- The nonce is only added when the policy declares `script-src`. Adding it to a policy that falls back to `default-src` would **narrow** what scripts are allowed instead of widening it.
- A nonce holding anything other than base64 characters is dropped. Otherwise a value like `nonce'; script-src *` could close the directive and rewrite the rest of the header.


## The middleware and its options
What a deployment is allowed to change lives in `ContentSecurityPolicyOptions`, bound from the `ContentSecurityPolicy` section: `Enabled`, `ReportOnly`, `ReportUri` and `AdditionalSources` (extra sources keyed by directive name). Notice what is **not** there: the directives themselves. Each host declares them in code, next to the resources it actually loads.

Let's write the middleware:

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

The header is written from `Response.OnStarting` rather than on the way in, for two reasons:
- **A response that already carries a policy keeps it.** The gateway proxies API responses that send their own, stricter one, and we don't want to overwrite it with a looser one.
- **The endpoint has run by then**, so a per-request nonce it published in `HttpContext.Items` is available.

`UseContentSecurityPolicy(policy, nonceHttpContextItemKey)` builds the header once, at startup: it returns early when `Enabled` is false, widens the policy with `WithAdditionalSources(options.AdditionalSources)` and `WithReportUri(options.ReportUri)`, picks `Content-Security-Policy-Report-Only` instead of `Content-Security-Policy` when `ReportOnly` is set, and registers the middleware with the resulting `ContentSecurityPolicyHeader`.

## Register it first
The order in the pipeline matters more than it seems. If the middleware sits after routing or after the exception handler, then redirects, 404s and error pages leave without a policy. Here is the API:

```csharp
// First in the pipeline: the policy is on the redirects, the 404s and the error
// responses too, not only on what reaches a controller.
app.UseContentSecurityPolicy(
    ContentSecurityPolicies.Api,
    nonceHttpContextItemKey: ScalarOptions.NonceHttpContextItemKey);
```

On the gateway, only the forwarded-headers handling comes before it (it touches no response), then:

```csharp
app.UseContentSecurityPolicy(ContentSecurityPolicies.SinglePageApplication);
```

Both hosts also call `services.AddContentSecurityPolicy(configuration)` to bind the options.


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
- `style-src 'self' 'unsafe-inline'`: the first deliberate concession (see below).
- `img-src 'self' data: blob: https:`: the second one.
- `font-src 'self' data:`: fonts come from the bundle.
- `connect-src 'self'`: `fetch`, XHR and `EventSource` only reach the gateway. With a BFF, the API, the session endpoints and the event stream are all on that origin anyway, so this costs nothing.
- `frame-src 'self'`: nothing third-party may be framed.
- `object-src 'none'`: no plugins.
- `base-uri 'self'`: an injected `<base>` tag cannot redirect every relative URL elsewhere.
- `form-action 'self'`: a form can only post back to the gateway.
- `frame-ancestors 'none'`: nobody can put the application in an iframe, which closes clickjacking.

### Why `style-src 'unsafe-inline'`
Angular adds component styles to the document **at runtime**, as `<style>` elements. A nonce would be the usual answer, but a nonce has to be fresh per response and written into the page, and here `index.html` is served statically. So the policy allows inline styles.

It is a bounded concession: styles execute nothing.

### Why `img-src https:`
Profile pictures come from the GitHub CDN, and the rich-text editor stores whatever image URL a user pastes. Listing hosts cannot cover the second case. Images execute nothing either, and if you drop that feature you can narrow it.

> **_Note:_**  `frame-src 'self'` was originally opened for a silent-login iframe. Once the session moved to ASP.NET Core's cookie and OpenID Connect handlers, that iframe disappeared. Nothing in the app frames a page today, so `'none'` would hold as well.

Everything that can **execute** (scripts, workers, plugins) is limited to one origin. The two wide directives only concern things that cannot run code.


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

What is opened up is exactly what the Scalar reference UI needs, all served by the API host itself. Two settings make that possible:

```csharp
app.MapScalarApiReference(options =>
{
    options
        // A fresh nonce per request lets the inline bootstrap script run under
        // `script-src 'self'` without 'unsafe-inline'.
        .WithNonce()
        // Its default fonts come from Scalar's CDN, which `default-src 'none'` blocks.
        .DisableDefaultFonts();
});
```

- `WithNonce()` makes Scalar generate a nonce per request and publish it in `HttpContext.Items` under `ScalarOptions.NonceHttpContextItemKey`. That is the key we passed to `UseContentSecurityPolicy`, so the middleware appends `'nonce-…'` to `script-src` on that response only.
- `DisableDefaultFonts()` keeps the API host from reaching out to a CDN at all.

Here, unlike for the SPA, the page is rendered per request, so a nonce is possible. That is the whole difference between the two `script-src` stories.


## What the front end had to give up
The policy broke one thing in the Angular build: **critical CSS inlining**. With it on, the build emits the critical CSS inline and loads the real stylesheet like this:

```html
<link rel="stylesheet" href="styles.css" media="print" onload="this.media='all'">
```

That `onload` is an inline event handler, and `script-src 'self'` blocks it. The result is an app that renders with only the critical CSS. The fix is in `front/application/angular.json`:

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

It costs a little first-paint time, and in exchange `index.html` carries nothing but same-origin `<link>` and `<script src>` tags. A dead `<link rel="preconnect" href="https://fonts.gstatic.com">` was removed from `index.html` at the same time, since every font the app uses is served from the bundle.

> **_Note:_**  This is the kind of breakage only an enforcing policy reveals. The unit tests stay green, the dev server works, and production loses its stylesheet. 😉


## Rolling it out with report-only
A directive change goes in the host's `ContentSecurityPolicies` class, with a comment saying why. An environment widens it from configuration, without a rebuild:

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

- **Development runs report-only** on both hosts (`appsettings.Development.json` sets `"ReportOnly": true`): the Angular dev server the gateway proxies has its own live-reload machinery. Every other environment enforces.
- `ReportUri` points the reports at a collector. Without it, violations are only visible in the browser console.
- `Enabled: false` is the break-glass switch, not a configuration choice.

The rollout of any change follows the same path: report-only, watch the reports, then enforce.


## How to verify
The policy type and the middleware have unit tests, for example `Should_write_the_policy_on_a_response_the_pipeline_never_reached`, `Should_keep_the_policy_the_response_already_carries` and `Should_ignore_the_nonce_when_it_is_not_a_base64_value`, which feeds it `nonce'; script-src *`.

On the API, an integration test asserts the exact header sent on a real route, and checks that an unknown route carries it too:

```csharp
var response = await client.GetAsync("/api/v1/billing/plans", TestContext.Current.CancellationToken);

response.Headers.GetValues(HeaderName)
    .Should()
    .BeEquivalentTo([
        "default-src 'none'; " +
        "script-src 'self'; " +
        "style-src 'self' 'unsafe-inline'; " +
        "img-src 'self' data:; " +
        "font-src 'self'; " +
        "connect-src 'self'; " +
        "base-uri 'none'; " +
        "form-action 'none'; " +
        "frame-ancestors 'none'"
    ]);
```

Asserting the full string is deliberate: a widened directive shows up as a failing test.

By hand, `curl` shows the headers of both hosts:

```bash
curl -I https://localhost:5071/
curl -I https://localhost:5001/api/v1/billing/plans
```

Then click through the app with the browser console open: every violation is logged there.


## Conclusion
A strict CSP for an Angular SPA is mostly a matter of being honest about the exceptions. Scripts, connections, frames and forms can all be locked to one origin. Inline styles cannot, because Angular injects them at runtime and a static `index.html` cannot carry a nonce. Images from any HTTPS host stay open because users paste them. Neither of those can execute code.

On the server side, a small immutable policy type, a middleware that writes from `OnStarting` and never overwrites an existing header, registered first in the pipeline, and a report-only switch are enough to send a policy on every response and change it safely.

This is how the gateway and the API send their policies in [Blouppy Starter](https://starter.blouppy.com/), whose [gateway documentation](https://docs.starter.blouppy.com/architecture/gateway/) describes the host the SPA is served from.

*Thanks for reading! 🙂*
