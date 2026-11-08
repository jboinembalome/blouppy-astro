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

Sooner or later, we need a service to behave a little differently, and the service is not ours. It comes from ASP.NET Core, from a NuGet package, or from another team. We cannot edit it, subclassing it ties us to one concrete class, and copying it means maintaining a fork of code we did not write.

ASP.NET Core authentication is a good example. Its schemes are registered at startup, once, by name. A B2B SaaS where each organization brings its own OpenID Connect provider needs a scheme per organization, added any day, without a restart. The framework has no extension point for that. It does have an interface, `IAuthenticationSchemeProvider`, and an interface is all the Decorator pattern needs.

In this article, we will see the shape of the Decorator pattern with a small example, then a real one from [Blouppy Starter](https://starter.blouppy.com/) that turns each organization's SSO connection into a scheme. We will register it with the plain Microsoft DI container, look at the trap that makes it call itself forever, meet the decorator we all use with `HttpClient`, and finish with when not to use it.


## The shape of a decorator
The Decorator is a **structural** pattern from the Gang of Four. A decorator implements an interface, holds another implementation of the same interface, and forwards to it. It adds behaviour before or after the call, or answers some calls itself. The caller sees one interface and does not know how many objects stand behind it.

Here is a minimal example, a caching decorator around a repository (an illustration, not code from the Starter):

```csharp
public interface IProductCatalog
{
    Task<Product?> FindAsync(int id, CancellationToken cancellationToken = default);
}

internal sealed class CachedProductCatalog(
    IProductCatalog inner,
    IMemoryCache cache) : IProductCatalog
{
    public async Task<Product?> FindAsync(int id, CancellationToken cancellationToken = default)
    {
        return await cache.GetOrCreateAsync(
            $"product:{id}",
            entry =>
            {
                entry.AbsoluteExpirationRelativeToNow = TimeSpan.FromMinutes(5);

                return inner.FindAsync(id, cancellationToken);
            });
    }
}
```

Three things make it a decorator:
- `CachedProductCatalog` **is** an `IProductCatalog`, so it can be handed to anyone who asks for one.
- It **has** an `IProductCatalog`, the one it wraps, and it never knows which class that is.
- It does one thing, caching. The real query stays in the inner class.

Nothing else changes: the consumers, the inner class and its tests stay as they are.


## The real example: one scheme per SSO connection
`IAuthenticationSchemeProvider` is how ASP.NET Core finds a scheme by name. When a challenge asks for `"GitHub"`, the authentication service calls `GetSchemeAsync("GitHub")`, gets back an `AuthenticationScheme` (a name, a display name and a handler type), and creates the handler. The default implementation, `AuthenticationSchemeProvider`, reads the schemes registered at startup.

The Starter's identity host keeps that behaviour and adds one rule: a name of the form `sso-{connectionId}` is answered from the organization's connection, read when it is asked for. Here is `SsoSchemeProvider`, trimmed:

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

    public Task<AuthenticationScheme?> GetDefaultChallengeSchemeAsync()
        => inner.GetDefaultChallengeSchemeAsync();

    public void AddScheme(AuthenticationScheme scheme)
        => inner.AddScheme(scheme);

    // ...the other defaults, TryAddScheme and RemoveScheme forward the same way.
}
```

The decorator decides one question, "is this name a connection?", and leaves everything else to `inner`:
- **Any other name is forwarded.** GitHub, Google and the cookie schemes keep working exactly as they did, because the decorator never looks at them.
- **A connection name is answered here.** The scheme it returns points at Microsoft's own `OpenIdConnectHandler`. The handler's named options are filled in by an `IConfigureNamedOptions<OpenIdConnectOptions>` from the same connection, which is why the decorator evicts them from `IOptionsMonitorCache` when the connection's version changes.
- **`GetAllSchemesAsync` is forwarded on purpose.** A connection is never listed, so the login page does not grow a button per customer.

The decorator owns no data. `ISsoConnectionLookup` reads the connection and caches it for a minute per replica. How the options are built, how the callback is reached and how the sign-in links an account are covered in [SSO and SCIM 2.0 for a B2B SaaS in ASP.NET Core](/blog/2026-10-13-sso-and-scim-for-a-b2b-saas-in-aspnet-core/). Here, what matters is the shape: one branch of new behaviour, and every other member a one-line forward.

Testing follows from that shape. The unit tests give `SsoSchemeProvider` a mocked `IAuthenticationSchemeProvider` and check both sides: a connection name never reaches the inner provider, and any other name does.


## Registering a decorator with the Microsoft DI container
The Microsoft container has no `Decorate` method. [Scrutor](https://github.com/khellang/Scrutor) adds one, but for one decorator the code is short enough to write. First, the two registrations that do not work.

### The trap: resolving the decorated service by its interface
The first idea is a factory that asks the container for the inner provider:

```csharp
// Wrong: the factory resolves itself.
services.AddSingleton<IAuthenticationSchemeProvider>(provider => new SsoSchemeProvider(
    provider.GetRequiredService<IAuthenticationSchemeProvider>(),
    provider.GetRequiredService<ISsoConnectionLookup>(),
    provider.GetRequiredService<IOptionsMonitorCache<OpenIdConnectOptions>>(),
    provider.GetRequiredService<SsoOptionsVersions>()));
```

When a service type is registered several times, `GetRequiredService` returns the **last** registration. The last one is this factory, so the factory calls itself, which calls itself again, until the stack overflows and the process dies. The container cannot see inside a factory, so nothing warns us at startup.

The second idea, `services.AddSingleton<IAuthenticationSchemeProvider, SsoSchemeProvider>()`, fails differently. The container builds `SsoSchemeProvider` from its constructor, sees that it needs an `IAuthenticationSchemeProvider`, which is `SsoSchemeProvider` again, and throws an `InvalidOperationException` for a circular dependency. A clearer error, but still no decorator.

### The registration the Starter uses
The fix is to take the inner registration **out** of the container, so it can no longer be resolved by its interface, and build it ourselves inside the decorator's factory:

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

- The **inner descriptor is kept**, so the decorator wraps whatever was registered: a type, an instance or a factory. `ActivatorUtilities.CreateInstance` builds a type from the container's other services without it being registered.
- The decorator **takes the inner's lifetime**. `AddAuthentication` registers the default provider as a singleton, so the decorator is one too, and there is exactly one inner instance.
- The method runs **last**. `Startup` calls `DecorateSsoSchemeProvider()` after every authentication registration, with a comment saying so. A provider registered after it would replace the decorator.


## The decorator we already use: DelegatingHandler
Every `HttpClient` from `IHttpClientFactory` goes through a chain of `DelegatingHandler`s. Each one is a decorator around an `HttpMessageHandler`: it receives the request, may change it, calls `base.SendAsync`, and may look at the response. Here is one that adds a correlation header (an illustration):

```csharp
internal sealed class CorrelationIdHandler : DelegatingHandler
{
    protected override Task<HttpResponseMessage> SendAsync(
        HttpRequestMessage request,
        CancellationToken cancellationToken)
    {
        request.Headers.TryAddWithoutValidation("X-Correlation-Id", Activity.Current?.TraceId.ToString());

        return base.SendAsync(request, cancellationToken);
    }
}

services.AddTransient<CorrelationIdHandler>();

services
    .AddHttpClient("catalog")
    .AddHttpMessageHandler<CorrelationIdHandler>();
```

The resilience handler and service discovery that Aspire's service defaults add to every client are decorators of the same kind. The Starter removes them from the SSO back-channel client with `ConfigureAdditionalHttpMessageHandlers((handlers, _) => handlers.Clear())`: retries would multiply every call to an issuer an administrator typed, and service discovery would resolve that host against the deployment's own services. Being able to take a wrapper off is part of what makes the pattern useful.


## Decorator, inheritance or middleware
The three can add behaviour around existing code. They differ in what they wrap:
- **Inheritance** wraps one concrete class. `AuthenticationSchemeProvider` has virtual methods, so a subclass could override `GetSchemeAsync`. It would also replace the provider instead of wrapping it: if another library had registered its own provider, the subclass would silently drop it. A decorator wraps whatever is registered, and two decorators can stack.
- **Middleware** wraps the HTTP request pipeline. It is the right tool for something every request needs, such as a header or a log scope. It cannot change what the authentication service gets back when it asks for a scheme by name: that call happens inside a handler, far from the pipeline.
- **A decorator** wraps one interface. It is the right tool when the change belongs to one service, wherever it is called from.


## The cost, and when not to use it
A decorator is cheap to write and costs something to live with:
- **Ordering matters.** With caching and logging decorators, whether a cache hit is logged depends on which one is outside. With DI, the order is the order of registration, which is easy to change by accident.
- **Stacks of wrappers hide the call.** A stack trace through three decorators shows three frames of forwarding before the real work, and "go to implementation" in the editor lands on the outermost one. Keeping each decorator to one concern is what keeps that readable.
- **Every member must be forwarded.** `SsoSchemeProvider` adds behaviour to one method and forwards ten. A new member on the interface is a compile error, which is safer than a silent gap, but each forward is a line someone has to read.
- **The registration is clever code.** Removing a descriptor and rebuilding it is less obvious than `AddSingleton`. It earns a name, a summary and a test.

And sometimes it is not needed at all. If we own the class, an `if` in the method is simpler than a wrapper. If the behaviour has two fixed variants chosen by configuration, two implementations and a `switch` at registration are clearer. The Decorator earns its place when we do not own the class, when the behaviour must be added to any implementation, or when the extra concern should be removable without touching the code it wraps.


## Conclusion
A decorator implements an interface, holds another implementation of it, and forwards. `SsoSchemeProvider` adds one rule to ASP.NET Core authentication, `sso-{id}` becomes an OpenID Connect scheme built from the organization's connection, and leaves every other name to the provider it wraps. With the plain Microsoft container, the registration removes the inner descriptor and resolves it from the descriptor, never by the interface, which would make the factory call itself. Use it for code we do not own or concerns we want to stack, and prefer an `if` when the class is ours.


## References
- [Design Patterns: Elements of Reusable Object-Oriented Software](https://en.wikipedia.org/wiki/Design_Patterns) — the Gang of Four book that catalogued the Decorator.
- [`IAuthenticationSchemeProvider` (Microsoft Learn)](https://learn.microsoft.com/dotnet/api/microsoft.aspnetcore.authentication.iauthenticationschemeprovider) — the interface `SsoSchemeProvider` decorates.
- [Overview of ASP.NET Core authentication (Microsoft Learn)](https://learn.microsoft.com/aspnet/core/security/authentication/) — schemes, handlers and challenges.
- [Dependency injection in .NET (Microsoft Learn)](https://learn.microsoft.com/dotnet/core/extensions/dependency-injection) — lifetimes and multiple registrations of one service.
- [`ActivatorUtilities.CreateInstance` (Microsoft Learn)](https://learn.microsoft.com/dotnet/api/microsoft.extensions.dependencyinjection.activatorutilities.createinstance) — building a type from the container without registering it.
- [Make HTTP requests using IHttpClientFactory: outgoing request middleware (Microsoft Learn)](https://learn.microsoft.com/aspnet/core/fundamentals/http-requests#outgoing-request-middleware) — `DelegatingHandler` and `AddHttpMessageHandler`.
- [Scrutor](https://github.com/khellang/Scrutor) — assembly scanning and a `Decorate` extension for the Microsoft container.
- [SSO and SCIM 2.0 for a B2B SaaS in ASP.NET Core](/blog/2026-10-13-sso-and-scim-for-a-b2b-saas-in-aspnet-core/) — the rest of the SSO flow around this decorator.
