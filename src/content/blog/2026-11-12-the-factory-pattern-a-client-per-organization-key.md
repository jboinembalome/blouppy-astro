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

Dependency injection builds most of our objects. We declare a constructor, register a type, and the container does the rest. That works as long as everything the object needs is known when the container builds it: options from configuration, other services, a logger.

Sometimes one argument is only known later. A SaaS that lets each organization bring its own API key for a language model is a good example: the client that calls the model needs that key, and the key is read from the database, decrypted, for one organization, in the middle of a request. The container cannot inject it, and calling `new` in the middle of a business service drags every other dependency of the client in with it.

In this article, we will look at the **Factory** pattern: its shape in C#, the factory that builds a model client per organization in [Blouppy Starter](https://starter.blouppy.com/), how that factory is tested, the factories .NET already gives us, and the cases where a `new`, a `Func<T>` or a keyed service does the job with less code.


## The shape of a factory
Factories are **creational** patterns in the Gang of Four catalogue. The book describes two of them: *Factory Method*, where a subclass decides which class to instantiate, and *Abstract Factory*, an interface that creates a family of related objects. In everyday .NET code, the form we meet most is simpler than both: an interface with one `Create` method, injected like any other service.

Here is the minimal version. A report needs a value known at call time, the culture of the reader, and a dependency the container owns, a clock:

```csharp
public interface IReportFactory
{
    Report Create(CultureInfo culture);
}

internal sealed class ReportFactory(TimeProvider timeProvider) : IReportFactory
{
    public Report Create(CultureInfo culture)
    {
        ArgumentNullException.ThrowIfNull(culture);

        return new Report(culture, timeProvider.GetUtcNow());
    }
}
```

Three things make it a factory rather than a plain helper:

- The **caller passes only what it knows**: the culture. It never sees `TimeProvider`.
- The factory **receives the rest from the container**, once, through its constructor.
- The caller depends on `IReportFactory`, so a test can hand it a fake that records what was asked for.

The *simple factory*, a static method with a `switch` that returns one of several types, is not in the Gang of Four book, but it is the most common factory of all, and we will meet one later.


## The problem: a key the container does not know
The AI module of Blouppy Starter talks to a model through a port, `ILlmClient`. The platform has its own key, set in configuration, and the registration builds the platform's client from it:

```csharp
services.AddTransient(provider => new AnthropicLlmClient(
    provider.GetRequiredService<IHttpClientFactory>(),
    provider.GetRequiredService<IOptions<LlmOptions>>().Value.Anthropic,
    provider.GetRequiredService<IOptions<LlmOptions>>().Value.Anthropic.ApiKey,
    provider.GetRequiredService<ILogger<AnthropicLlmClient>>()));
```

That lambda is already a small factory: a delegate the container calls each time it resolves the type. It works because the key is in configuration, available to the container.

An organization can also save its own key. It is stored encrypted, read for one organization when a call is made, and decrypted through `ISecretProtector`. No registration can express "the key of whichever organization this request is about". We still want everything else from the platform: the same named `HttpClient`, the same retries and timeouts, the same logging. That is the factory's job.

The port lives with the other LLM ports in `Blouppy.Infrastructure.Llm.Abstractions`:

```csharp
public interface ILlmClientFactory
{
    /// <exception cref="ArgumentException">No adapter serves <paramref name="provider"/>.</exception>
    ILlmClient Create(
        string provider,
        string apiKey);
}
```

The caller passes the two values only it knows: which provider the organization chose and its decrypted key. It gets back an `ILlmClient`, the same port as the platform's client, so the code that sends the request cannot tell the two apart.


## The factory
The implementation sits next to the Anthropic adapter, in `Blouppy.Infrastructure.Llm`:

```csharp
internal sealed class LlmClientFactory(
    IHttpClientFactory httpClientFactory,
    IOptions<LlmOptions> options,
    ILoggerFactory loggerFactory) : ILlmClientFactory
{
    public ILlmClient Create(
        string provider,
        string apiKey)
    {
        if (!string.Equals(provider, AnthropicLlmClient.ProviderName, StringComparison.OrdinalIgnoreCase))
        {
            throw new ArgumentException($"No adapter serves the provider '{provider}'.", nameof(provider));
        }

        return new AnthropicLlmClient(
            httpClientFactory,
            options.Value.Anthropic,
            apiKey,
            loggerFactory.CreateLogger<AnthropicLlmClient>());
    }
}
```

- **What it keeps from the platform**: `IHttpClientFactory`, so the client gets the same named `HttpClient` as the platform's, with its handlers cleared and its request logging removed; `IOptions<LlmOptions>`, so retries, timeouts and the refusal fallback are the platform's settings whoever's key it is; `ILoggerFactory`, so the client logs like any other.
- **What it does not need**: the platform's key. An organization's own key works on a server that has none.
- **One provider today**: the check on `provider` is where a second adapter would be chosen. The exception message names the provider and never the key.
- It is registered as a **singleton**: it holds nothing per request, and every dependency it takes is a singleton too.

```csharp
services.AddSingleton<ILlmClientFactory, LlmClientFactory>();
```

The `AnthropicLlmClient` constructor stays `internal`. Outside the adapter project, the factory is the only way to get a client on a key other than the platform's.


## Who calls it
A factory that anyone can call is an easy way around the rules. Every call to a model goes through the AI gateway, which checks the organization's switch, counts the credits and writes the usage ledger (see [an AI gateway for your SaaS](/blog/2026-10-19-an-ai-gateway-for-your-saas/)). A service that built its own client on an organization's key would skip all of that.

So one class injects the factory, `OrganizationLlmClientResolver`, and only the gateway injects the resolver. Trimmed to the factory call:

```csharp
internal sealed class OrganizationLlmClientResolver(
    IOrganizationAiKeysRepository organizationAiKeysRepository,
    IOrganizationsPublicDataService organizationsPublicDataService,
    ISecretProtector secretProtector,
    ILlmClientFactory clientFactory,
    OrganizationLlmClients organizationClients) : ILlmClientResolver
{
    public async Task<LlmClientResolution> ResolveAsync(
        OrganizationId organizationId,
        ILlmClient platformClient,
        CancellationToken cancellationToken = default)
    {
        // The key is missing, or the plan no longer allows it: the platform's client answers.
        // ...

        var client = organizationClients.GetOrAdd(
            organizationId,
            organizationAiKey.ProtectedValue,
            () => clientFactory.Create(
                organizationAiKey.Provider.ToString(),
                secretProtector.Unprotect(OrganizationAiKeys.ProtectionPurpose, organizationAiKey.ProtectedValue)));

        return new LlmClientResolution(client, AiKeySource.Organization);
    }
}
```

The factory is called inside a `Func<ILlmClient>`. `OrganizationLlmClients` keeps one client per organization in a `MemoryCache`, filed under the stored form of the key, and runs the delegate only when no cached client matches. The key is decrypted once, and a key replaced on another replica no longer matches, so the next call builds a new client. When the key can no longer be decrypted, the resolver catches the `CryptographicException` and refuses the call rather than falling back on the platform's key.

Two architecture tests hold the boundary: one fails the build if any type other than the resolver injects `ILlmClientFactory`, the other if any type other than the gateway injects the resolver.


## Testing it
A factory is tested on two sides.

**The factory itself** is tested against a host built with the real registration and a scripted HTTP handler. The test asks the container for `ILlmClientFactory`, builds a client on an organization's key, and checks the request that left:

```csharp
[Fact]
public async Task Should_never_send_the_platform_key_when_the_client_is_built_on_another()
{
    // Arrange
    var handler = new ScriptedAnthropicHandler()
        .RespondsWithJson(AnthropicPayloads.Message("""[{"type":"text","text":"Done."}]"""));

    await using var serviceProvider = AnthropicTestHost.Build(handler);

    // Act
    await serviceProvider.GetRequiredService<ILlmClientFactory>()
        .Create("Anthropic", OrganizationKey)
        .CompleteAsync(Given_a_request(), TestContext.Current.CancellationToken);

    // Assert
    handler.Requests.Single().Headers["x-api-key"]
        .Should()
        .Be(OrganizationKey)
        .And
        .NotBe(AnthropicTestHost.ApiKey);
}
```

The same class checks that a client works with no platform key configured, that an unknown provider throws an `ArgumentException` that does not contain the key, and that a provider error echoing the key never carries it into the exception.

**The caller** is tested with a hand-written fake. The resolver's tests pass a `RecordingLlmClientFactory` that returns a fresh fake client and records each `(provider, apiKey)` it was asked for:

```csharp
private sealed class RecordingLlmClientFactory : ILlmClientFactory
{
    private readonly List<BuiltClient> _built = [];

    public IReadOnlyList<BuiltClient> Built
        => _built;

    public ILlmClient Create(
        string provider,
        string apiKey)
    {
        var client = new FakeLlmClient();

        _built.Add(new BuiltClient(provider, apiKey, client));

        return client;
    }
}
```

That makes the cache rules easy to assert: one client built for two calls with the same key, two clients built when the key was replaced in between, in that order. This is the main gain of a factory interface over a `new` in the resolver: the test controls what gets built and sees what was asked.


## A simple factory: the notification e-mail
Not every factory needs an interface. `NotificationEmailFactory` in Blouppy Starter turns a notification into the subject and body of an e-mail. It is a static method with a `switch` expression, trimmed here:

```csharp
internal static class NotificationEmailFactory
{
    public static (string Subject, string Body) Create(
        NotificationType type,
        IReadOnlyDictionary<string, string> parameters,
        string? link)
        => type switch
        {
            NotificationType.OrganizationInvitation => (
                $"You've been invited to {Read(parameters, NotificationParameterNames.OrganizationName)}",
                Body(
                    heading: "You've been invited",
                    lead: $"{Read(parameters, NotificationParameterNames.ActorName)} invited you to join an organization",
                    rows: [("Organization", Read(parameters, NotificationParameterNames.OrganizationName))],
                    callToAction: "Accept the invitation",
                    link: link)),

            _ => throw new ArgumentOutOfRangeException(nameof(type), type, "No e-mail is defined for this notification type.")
        };
}
```

It has no dependency to receive, no state, and nothing a test would want to replace: its output is a pure function of its input, and the dispatcher's tests can assert on the e-mail it produces. A static method is the right size here. Wrapping it in an interface would add a registration and a mock for nothing.


## Factories .NET already gives us
Before writing one, we check that the framework does not already ship it:

- [`IHttpClientFactory`](https://learn.microsoft.com/dotnet/core/extensions/httpclient-factory) creates `HttpClient` instances by name and pools their handlers, which avoids both socket exhaustion and stale DNS. `LlmClientFactory` depends on it rather than replacing it.
- [`IDbContextFactory<TContext>`](https://learn.microsoft.com/ef/core/dbcontext-configuration/#use-a-dbcontext-factory), registered with `AddDbContextFactory`, creates a `DbContext` on demand. It is the answer when the consumer outlives a scope, such as a singleton or a Blazor component, or needs several contexts at once.
- `ILoggerFactory` creates loggers by category, as the factory above does.


## When not to write a factory
A factory interface is one more type to register, name and read. It is often more than the problem needs.

- **`new` is fine** for an object with no dependency from the container: a value object, a DTO, a domain entity, an exception. `new Money(10, "EUR")` needs no factory.
- **A static method is enough** when creation is a pure decision on its input, as with the notification e-mail. A `switch` expression on an enum is a perfectly good simple factory.
- **A `Func<T>` is enough** when the caller needs to create instances later, or several of them, and takes no runtime argument. The default Microsoft container does not resolve `Func<T>` on its own, so we register it ourselves: `services.AddTransient<Func<Report>>(provider => () => provider.GetRequiredService<Report>())`. Past one or two parameters, an interface with named parameters reads better.
- **A keyed service is enough** when the choice comes from a small, fixed set known at startup. Since .NET 8, `AddKeyedSingleton<IPaymentGateway, StripePaymentGateway>("stripe")` and `[FromKeyedServices("stripe")]` choose between registered implementations without a hand-written `switch`. It does not help with our case: a key is a value, not a registration.

The cost to watch is the **service locator**. A factory that takes `IServiceProvider` and returns whatever type it is asked for hides a class's real dependencies: they no longer appear in its constructor, a missing registration fails at run time instead of at startup, and a test has to build a container to find out what the class needs. A good factory has a narrow return type, takes the values only the caller knows, and receives its own dependencies through its constructor, as `LlmClientFactory` does. If a factory's `Create` method is generic over any `T`, it has turned into a locator.


## Conclusion
A factory earns its place when an object needs a value that only exists at call time, an organization's decrypted key here, along with dependencies the container owns. The caller passes what it knows, the factory adds the platform's `HttpClient`, options and logging, and the caller depends on an interface a test can replace with a recording fake. Keep the factory narrow, limit who may inject it when it bypasses a rule, and reach for `new`, a static `switch`, a `Func<T>` or a keyed service first when they are enough.


## References
- [Design Patterns: Elements of Reusable Object-Oriented Software](https://www.oreilly.com/library/view/design-patterns-elements/0201633612/) — the Gang of Four book, with Factory Method and Abstract Factory.
- [Dependency injection in .NET](https://learn.microsoft.com/dotnet/core/extensions/dependency-injection) — registrations, lifetimes, factory delegates and keyed services.
- [IHttpClientFactory with .NET](https://learn.microsoft.com/dotnet/core/extensions/httpclient-factory) — named clients and handler pooling.
- [Using a DbContext factory](https://learn.microsoft.com/ef/core/dbcontext-configuration/#use-a-dbcontext-factory) — `AddDbContextFactory` and `IDbContextFactory<TContext>`.
- [Service Locator is an Anti-Pattern](https://blog.ploeh.dk/2010/02/03/ServiceLocatorisanAnti-Pattern/) — Mark Seemann on why hidden dependencies hurt.
- [An AI gateway for your SaaS](/blog/2026-10-19-an-ai-gateway-for-your-saas/) — the gateway that the resolver and this factory serve.
- [Blouppy Starter](https://starter.blouppy.com/) — the starter kit the examples come from.
