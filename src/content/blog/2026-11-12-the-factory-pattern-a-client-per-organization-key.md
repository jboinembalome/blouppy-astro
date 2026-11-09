---
templateKey: 'blog-post'
title: 'The Factory pattern in C#: a model client built for each organization''s key'
date: 2026-11-12T09:00:00.000Z
author: Jimmy Boinembalome
authorimage: /img/jimmy.jpg
category: C#
topic: 'Architecture'
illustration: 2
categorycolor: bg-purple-100 text-purple-800
featuredpost: true
description: >-
  Learn when a factory earns its place in .NET: building an object from a value known only at call time, keeping what DI provides, testing it, and when new or Func<T> is enough.
tags:
  - Development
  - C#
  - Design Patterns
  - ASP.NET Core
---

Dependency injection builds most of our objects, as long as everything they need is known when the container builds them. Sometimes one argument only exists later. An app where each organization can bring its own API key for a language model is a good example: the key is read from the database and decrypted in the middle of a request, so the container cannot inject it.

Calling `new` in the business service is not great either: the client also needs an `HttpClient`, options and a logger, and the service would have to carry all of them. That is the job of a factory.


## The shape
A factory is an interface with one `Create` method. The caller passes what only it knows; the factory receives everything else from the container:

```csharp
public interface ILlmClientFactory
{
    ILlmClient Create(string apiKey);
}

internal sealed class LlmClientFactory(
    IHttpClientFactory httpClientFactory,
    IOptions<LlmOptions> options,
    ILoggerFactory loggerFactory) : ILlmClientFactory
{
    public ILlmClient Create(string apiKey)
        => new AnthropicLlmClient(
            httpClientFactory,
            options.Value.Anthropic,
            apiKey,
            loggerFactory.CreateLogger<AnthropicLlmClient>());
}
```

The factory is a singleton: it holds nothing per request. The client it builds gets the same named `HttpClient`, retries and timeouts as the platform's own client; only the key differs. And since `Create` returns the `ILlmClient` port, the code that sends the request cannot tell an organization's client from the platform's.

The caller stays short:

```csharp
var apiKey = secretProtector.Unprotect(Purpose, organizationKey.ProtectedValue);

var client = clientFactory.Create(apiKey);
```

This is, minus the choice of provider, how the AI module of [Blouppy Starter](https://starter.blouppy.com/) builds a client for an organization's key. One more rule matters there: every call to a model must go through the AI gateway, which counts credits and writes the usage ledger. A factory anyone can inject is an easy way around that, so an architecture test fails the build if any class other than the gateway's resolver injects `ILlmClientFactory`.


## Testing it
The interface is what makes the caller testable. A test hands it a fake that records every key it was asked for and returns a fake client, then asserts on what was built: one client for two calls with the same key, a new one once the key has been replaced.

The factory itself is tested once, against the real registration and a scripted HTTP handler, to check that the request carries the organization's key and never the platform's.


## When a factory is too much
A factory interface is one more type to register and read. Often something smaller does the job:

- **`new`** for anything with no dependency from the container: a value object, a DTO, an exception.
- **A static method with a `switch`** when creation is a pure decision on the input, such as building an e-mail's subject and body from a notification type.
- **A `Func<T>`** when the caller needs new instances later but passes no argument.
- **A keyed service** (`AddKeyedSingleton`, `[FromKeyedServices]`) when the choice is between a few implementations known at startup. It does not help with an API key: a key is a value, not a registration.

Before writing one, check that .NET does not already ship it: `IHttpClientFactory`, `IDbContextFactory<TContext>` and `ILoggerFactory` are all factories.

The trap to avoid is a factory that takes `IServiceProvider` and returns any `T`. That is a service locator: the real dependencies disappear from the constructor, and a missing registration fails at run time instead of at startup. A good factory has a narrow return type and takes only the values the caller knows.


## References
- [Dependency injection in .NET](https://learn.microsoft.com/dotnet/core/extensions/dependency-injection) — Microsoft Learn: lifetimes, factory delegates and keyed services.
- [IHttpClientFactory with .NET](https://learn.microsoft.com/dotnet/core/extensions/httpclient-factory) — Microsoft Learn: named clients and handler pooling.
- [Service Locator is an Anti-Pattern](https://blog.ploeh.dk/2010/02/03/ServiceLocatorisanAnti-Pattern/) — Mark Seemann on why hidden dependencies hurt.
- [An AI gateway for your SaaS](/blog/2026-10-19-an-ai-gateway-for-your-saas/) — the gateway this factory serves.
