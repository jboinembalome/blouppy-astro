---
templateKey: 'blog-post'
title: 'The Decorator pattern in C#: adding SSO schemes to ASP.NET Core authentication'
date: 2026-11-19T09:00:00.000Z
author: Jimmy Boinembalome
authorimage: /img/jimmy.jpg
category: C#
topic: 'Architecture'
illustration: 1
categorycolor: bg-purple-100 text-purple-800
featuredpost: true
description: >-
  Learn the Decorator pattern in C# by wrapping ASP.NET Core's IAuthenticationSchemeProvider, register it with the plain Microsoft DI container, and avoid the infinite-recursion trap.
tags:
  - Development
  - C#
  - Design Patterns
  - ASP.NET Core
---

Sooner or later, a service has to behave a little differently, and the service is not ours. It comes from ASP.NET Core or a NuGet package. We cannot edit it, a subclass ties us to one concrete class, and a copy is a fork to maintain.

ASP.NET Core authentication is a good example. Its schemes are registered at startup, once, by name. A B2B SaaS where each organization brings its own OpenID Connect provider needs a scheme per organization, added any day, without a restart. The framework has no extension point for that. It does have an interface, `IAuthenticationSchemeProvider`, and an interface is all the Decorator pattern needs.


## The shape
A decorator implements an interface, holds another implementation of the same interface, and forwards to it. It adds behaviour before or after the call, or answers some calls itself. The caller sees one interface and does not know how many objects stand behind it. A caching `IProductCatalog` that wraps the real `IProductCatalog` is the textbook case: the query stays in the inner class, the cache in the wrapper, and no consumer changes.


## One scheme per SSO connection
`IAuthenticationSchemeProvider` is how ASP.NET Core finds a scheme by name. When a challenge asks for `"GitHub"`, the authentication service calls `GetSchemeAsync("GitHub")`. It gets back an `AuthenticationScheme`, a name and a handler type, and creates the handler.

The identity host of [Blouppy Starter](https://starter.blouppy.com/) keeps that behaviour and adds one rule. A name of the form `sso-{connectionId}` is answered from the organization's connection, read when it is asked for. Here is `SsoSchemeProvider`, trimmed:

```csharp
internal sealed class SsoSchemeProvider(
    IAuthenticationSchemeProvider inner,
    ISsoConnectionLookup lookup,
    IOptionsMonitorCache<OpenIdConnectOptions> optionsCache,
    SsoOptionsVersions versions) : IAuthenticationSchemeProvider
{
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

        // Evict the named options when the connection changed since they were built.
        if (versions.Swap(name, connection.Version) != connection.Version)
        {
            optionsCache.TryRemove(name);
        }

        return new AuthenticationScheme(name, connection.DisplayName, typeof(OpenIdConnectHandler));
    }

    public Task<IEnumerable<AuthenticationScheme>> GetAllSchemesAsync()
        => inner.GetAllSchemesAsync();

    // ...every other member forwards to inner the same way.
}
```

The decorator decides one question, "is this name a connection?", and leaves everything else to `inner`. GitHub, Google and the cookie schemes keep working exactly as before, because the decorator never looks at them. A connection name gets a scheme that points at Microsoft's own `OpenIdConnectHandler`, whose named options are built from the same connection. `GetAllSchemesAsync` is forwarded on purpose: a connection is never listed, so the login page does not grow a button per customer.

The unit tests follow that shape. They give the decorator a mocked inner provider and check both sides: a connection name never reaches it, and any other name does. The rest of the SSO flow is in [SSO and SCIM 2.0 for a B2B SaaS in ASP.NET Core](/blog/2026-10-13-sso-and-scim-for-a-b2b-saas-in-aspnet-core/).


## Registering it without calling itself
The Microsoft container has no `Decorate` method. [Scrutor](https://github.com/khellang/Scrutor) adds one, but for one decorator the code is short enough to write. The first idea is a factory that asks the container for the inner provider:

```csharp
// Wrong: the factory resolves itself.
services.AddSingleton<IAuthenticationSchemeProvider>(provider => new SsoSchemeProvider(
    provider.GetRequiredService<IAuthenticationSchemeProvider>(),
    /* ... */));
```

When a service type is registered several times, `GetRequiredService` returns the **last** registration. The last one is this factory, so it calls itself until the stack overflows. The container cannot see inside a factory, so nothing warns at startup. Registering `AddSingleton<IAuthenticationSchemeProvider, SsoSchemeProvider>()` fails too, with a circular dependency error.

The fix is to take the inner registration **out** of the container and build it inside the decorator's factory:

```csharp
public IServiceCollection DecorateSsoSchemeProvider()
{
    var inner = services.Last(x => x.ServiceType == typeof(IAuthenticationSchemeProvider));

    services.Remove(inner);

    services.Add(new ServiceDescriptor(
        typeof(IAuthenticationSchemeProvider),
        provider => new SsoSchemeProvider(
            (IAuthenticationSchemeProvider)Resolve(provider, inner),
            provider.GetRequiredService<ISsoConnectionLookup>(),
            provider.GetRequiredService<IOptionsMonitorCache<OpenIdConnectOptions>>(),
            provider.GetRequiredService<SsoOptionsVersions>()),
        inner.Lifetime));

    return services;
}

private static object Resolve(IServiceProvider provider, ServiceDescriptor descriptor)
    => descriptor.ImplementationInstance
       ?? descriptor.ImplementationFactory?.Invoke(provider)
       ?? ActivatorUtilities.CreateInstance(provider, descriptor.ImplementationType!);
```

Keeping the inner descriptor means the decorator wraps whatever was registered: a type, an instance or a factory. The decorator takes the inner's lifetime, a singleton here. And the method must run last: `Startup` calls it after every authentication registration, because a provider registered later would replace the decorator.


## The decorator we already use
Every `HttpClient` from `IHttpClientFactory` goes through a chain of `DelegatingHandler`s. Each one wraps the next handler, may change the request, and calls `base.SendAsync`. The resilience handler and service discovery that Aspire adds to every client are decorators of that kind.

Being able to take a wrapper off matters as much. The Starter clears them from the SSO back-channel client. Retries would multiply every call to an issuer an administrator typed, and service discovery would resolve that host against the deployment's own services.


## When not to use it
Inheritance could override `GetSchemeAsync` too, but it would replace the registered provider instead of wrapping it. Middleware wraps the request pipeline, far from the call that asks for a scheme by name. A decorator is the tool when the change belongs to one service, wherever it is called from.

It has a cost. With several decorators, the order of registration decides the behaviour, and it is easy to change by accident. Every member must be forwarded: `SsoSchemeProvider` adds behaviour to one method and forwards the rest. And if we own the class, an `if` in the method is simpler than a wrapper.


## References
- [`IAuthenticationSchemeProvider` (Microsoft Learn)](https://learn.microsoft.com/dotnet/api/microsoft.aspnetcore.authentication.iauthenticationschemeprovider) — the interface `SsoSchemeProvider` decorates.
- [Dependency injection in .NET (Microsoft Learn)](https://learn.microsoft.com/dotnet/core/extensions/dependency-injection) — lifetimes and multiple registrations of one service.
- [Scrutor](https://github.com/khellang/Scrutor) — a `Decorate` extension for the Microsoft container.
- [SSO and SCIM 2.0 for a B2B SaaS in ASP.NET Core](/blog/2026-10-13-sso-and-scim-for-a-b2b-saas-in-aspnet-core/) — the rest of the SSO flow around this decorator.
