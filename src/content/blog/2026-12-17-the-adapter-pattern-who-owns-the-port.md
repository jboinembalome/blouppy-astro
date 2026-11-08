---
templateKey: 'blog-post'
title: 'The Adapter pattern in C#: who owns the interface?'
date: 2026-12-17T09:00:00.000Z
author: Jimmy Boinembalome
authorimage: /img/jimmy.jpg
category: C#
topic: 'Architecture'
illustration: 2
categorycolor: bg-purple-100 text-purple-800
featuredpost: true
description: >-
  Learn the Adapter pattern in C# on a real model client and file storage, and weigh three places to put the interface it implements: the domain, a shared port project, or nowhere.
tags:
  - Development
  - C#
  - Design Patterns
  - Architecture
---

A library rarely has the interface our code wants. The SDK names things its own way, throws its own exceptions, streams its own events and changes them between versions. When our services call it directly, every one of those choices spreads into code that should not care which vendor answers.

The Adapter pattern is the usual answer: we write the interface we want, and one class translates it to the library. The harder question comes right after, and the pattern does not answer it: **who owns that interface?** The domain that needs it, a shared project next to the adapter, or nobody at all?

In this article, we will look at the Adapter pattern on a small example, then at two real adapters of [Blouppy Starter](https://starter.blouppy.com/), a model client and a file storage. Then we will weigh the three places the interface can live, say which one the Starter picked and what it costs.


## The pattern
The Adapter is a **structural** pattern from the Gang of Four book. It converts the interface of a class into another interface that clients expect, so classes with incompatible interfaces can work together. There are three roles:

- The **target**: the interface the client calls.
- The **adaptee**: the existing class with the wrong interface, often a third-party one.
- The **adapter**: the class that implements the target and calls the adaptee.

Here is a vendor SMS client we cannot change:

```csharp
// Third-party: its shape is the vendor's.
public sealed class AcmeSmsClient
{
    public AcmeSmsResult Send(string msisdn, string text, int priority) { /* ... */ }
}

public sealed record AcmeSmsResult(int Code, string? Error);
```

Our code wants something else: a typed phone number, async, and an exception of ours when the message is not sent. That is the target:

```csharp
public interface ITextMessageSender
{
    Task SendAsync(PhoneNumber to, string body, CancellationToken cancellationToken = default);
}
```

The adapter holds the adaptee and translates both directions:

```csharp
internal sealed class AcmeTextMessageSender(AcmeSmsClient client) : ITextMessageSender
{
    private const int NormalPriority = 2;

    public Task SendAsync(PhoneNumber to, string body, CancellationToken cancellationToken = default)
    {
        var result = client.Send(to.Value, body, NormalPriority);

        if (result.Code != 0)
        {
            throw new TextMessageNotSentException($"The provider refused the message ({result.Code}).");
        }

        return Task.CompletedTask;
    }
}
```

This is an **object adapter**: it wraps an instance. The book also describes a class adapter, which inherits from the adaptee. In C#, a class inherits from one base class only, and SDK types are often `sealed`, so the object adapter is the form we use in practice.

**Adapter, facade and decorator** are easy to confuse. An adapter changes the interface of one thing into the interface a client already expects. A facade gives a new, simpler interface over several parts. A decorator keeps the same interface and adds behaviour around it.


## A real adapter: a model client
The Starter calls a language model through a port named `ILlmClient`. Its shape is the Starter's own, not the provider's (trimmed):

```csharp
namespace Blouppy.Infrastructure.Llm.Abstractions;

public interface ILlmClient
{
    bool IsConfigured { get; }

    string Provider { get; }

    Task<LlmResponse> CompleteAsync(
        LlmRequest request,
        CancellationToken cancellationToken = default);

    IAsyncEnumerable<LlmStreamEvent> StreamAsync(
        LlmRequest request,
        CancellationToken cancellationToken = default);
}
```

`AnthropicLlmClient` is the adapter, over the official Anthropic SDK's Messages client. Its completion shows the three steps every adapter has: map the request, call the adaptee, map the answer or the failure.

```csharp
internal sealed class AnthropicLlmClient : ILlmClient, IDisposable
{
    public async Task<LlmResponse> CompleteAsync(
        LlmRequest request,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(request);

        var parameters = AnthropicRequestMapper.ToParams(request, _options.RefusalFallback);

        try
        {
            var message = await _client.Beta.Messages.Create(parameters, cancellationToken);

            return AnthropicResponseMapper.ToResponse(message);
        }
        catch (Exception exception) when (IsProviderFailure(exception, cancellationToken))
        {
            throw Translate(exception);
        }
    }

    // The caller's own cancellation is not a failure, and passes through as it is.
    private static bool IsProviderFailure(Exception exception, CancellationToken cancellationToken)
        => !cancellationToken.IsCancellationRequested
           && exception is AnthropicException or HttpRequestException or OperationCanceledException;
}
```

What it translates:

- **The request.** `AnthropicRequestMapper` turns an `LlmRequest` into the SDK's `MessageCreateParams`: our `LlmEffort` becomes the SDK's `Effort`, a response schema becomes a JSON output format, the system prompt and the tools get the cache breakpoints, and `EndUserId` goes into the request metadata.
- **The errors.** The SDK's exceptions never leave the adapter:

```csharp
return exception switch
{
    AnthropicRateLimitException => new LlmRateLimitedException(retryAt: null),
    AnthropicUnauthorizedException or AnthropicForbiddenException
        => new LlmKeyRejectedException("Anthropic refused the API key."),
    Anthropic4xxException
        => new LlmRejectedRequestException($"Anthropic rejected the request ({(int)statusCode!})."),
    OperationCanceledException
        => new LlmUnavailableException("Anthropic did not answer in time."),
    _ => new LlmUnavailableException("Anthropic could not answer.")
};
```

The SDK's exception is deliberately **not** kept as the inner exception: its message carries the response body, and whoever logs an exception writes its inner ones too.

- **The stream.** The provider streams low-level events: a block starts, a delta arrives, a block stops. `AnthropicStreamAccumulator` folds them into the port's events: `LlmTextDelta` as text comes, `LlmToolCallCompleted` once a tool call's JSON arguments are whole, `LlmUsageReported` each time the token counts move, and `LlmStreamCompleted` with the stop reason. The caller never sees a partial JSON fragment.

An adapter is rarely one method call. Most of its code is this kind of translation, and that is the point: the translation exists once.


## Two adapters behind one port
`IFileStorage` (`SaveAsync`, `TryOpenReadAsync`, `DeleteAsync`, `DeleteFolderAsync`) has two adapters, `LocalDiskFileStorage` and `S3FileStorage`, and `FileStorage:Provider` picks one at registration. The interesting part is where the two adaptees disagree. A missing file is a result in the port, and the S3 adapter has to make it one:

```csharp
public async Task<SearchResult<Stream>> TryOpenReadAsync(
    StoragePath path,
    CancellationToken cancellationToken = default)
{
    ArgumentNullException.ThrowIfNull(path);

    try
    {
        var response = await client.GetObjectAsync(_options.BucketName, ObjectKeyOf(path.Value), cancellationToken);

        return SearchResult.Create(response.ResponseStream);
    }
    // The key only: a missing bucket is a 404 too, and taking it for a missing file would expire every
    // export instead of reporting the misconfiguration.
    catch (AmazonS3Exception exception) when (exception.ErrorCode == NoSuchKey)
    {
        return SearchResult.NotFound<Stream>();
    }
}
```

The disk adapter checks whether the file exists; the S3 adapter reads an error code. The S3 adapter also spools a non-seekable stream to a temporary file before the upload, because a PUT has to announce its length. The callers see neither.


## Where the interface lives
The pattern says an adapter implements a target. It does not say which project declares the target. Here are three honest answers.

### 1. The domain declares its port
This is the classic reading of [hexagonal architecture](/blog/2026-05-04-hexagonal-architecture-in-dotnet/) and of dependency inversion: the code that needs a capability declares it, in its own words, and the adapter depends on it. The port then speaks the domain's language: `ChargeSubscription`, never `CreatePaymentIntent`.

The Starter does this too, in one place. The billing module declares `IPaymentGateway` as an `internal` interface inside `Blouppy.Billing`, and `StripePaymentGateway` implements it in the module's own `Infrastructure/Payments` folder. Only one module takes money, so nobody else needs the port.

- **Gains:** the port is shaped by its one caller, and nothing outside sees it.
- **Costs:** a second domain that needs the same capability either declares a second port, with a second adapter, or reaches into the first domain, which breaks the boundary.

### 2. A port project per technical concern
This is what the Starter does for everything else. Each driven port lives in a `Blouppy.Infrastructure.<Concern>.Abstractions` project: `ILlmClient` in `Blouppy.Infrastructure.Llm.Abstractions`, `IFileStorage` in `Blouppy.Infrastructure.FileStorage.Abstractions`, `IEmailSender` in `Blouppy.Infrastructure.Email.Abstractions`. The adapter sits next door in `Blouppy.Infrastructure.<Concern>`, and each domain references only the port projects it uses.

- **Gains: one port for several callers.** `IEmailSender` is referenced by Notifications, Organizations, Privacy and the identity host, which is a separate application with its own hexagon. `IFileStorage` serves the identity host's avatars and the Privacy module's data exports. One adapter, one set of tests, one place to fix a bug.
- **Gains: the port can stand alone.** An architecture test, `The_port_should_reference_nothing_but_the_runtime`, holds `Blouppy.Infrastructure.Llm.Abstractions` to `System` assemblies only, so it could be published as a package as it is.
- **Gains: the port stays out of the Web's reach.** A module's own `.Abstractions` project is the contract its controllers consume. Had `ILlmClient` lived in `Blouppy.Ai.Abstractions`, a controller could inject it and skip the AI gateway's checks.

The cost is real, and it is a fair objection to this layout: **is it really the domain's job to expose that port, and if it is not, whose words does the port use?** A shared port has no single owner, so its vocabulary drifts toward the technology. `LlmRequest` speaks of `MaxOutputTokens`, `LlmEffort` and `LlmCaching.StablePrefix`; no domain thinks in prompt caching. In the Starter, the AI module sits between the two: a feature asks for "a workspace description draft", and the module turns that into an `LlmRequest`, so the domain still does not see the vocabulary. But the port is a model client, not a domain need. The repositories show the same drift the other way: `IWorkspacesRepository` lives in `Blouppy.Infrastructure.Database.Abstractions`, so that one port project has a folder per domain and knows all their models.

### 3. No port at all
A small application with one caller can use the SDK directly. There is no interface to keep in step, no mapper and no second set of exception types. The price shows up later: tests need the SDK or a mock of its types, its exceptions reach the callers, and changing the vendor touches every one of them. For a prototype, an internal tool or a script, that price may never be paid.

### What the Starter picked, and why
The Starter picked the second option for its technical concerns and the first for billing. The reasoning is reuse across hexagons and a port that can stand alone, at the cost of a technical vocabulary in the port and a translation layer above it where the domain needs its own words. A team with one domain per capability, or one that wants every port named after a business need, can reasonably pick the first option everywhere. Neither is the only right one; what matters is that the choice is written down and enforced.


## Keeping the SDK inside the adapter
An adapter only protects the callers if nobody walks around it. The Starter checks it with [architecture tests](/blog/2026-07-03-architecture-tests-that-fail-the-build/) over the compiled assemblies:

- `LlmBoundaryTests.Only_the_adapters_should_reference_a_provider_sdk` fails the build if any assembly other than `Blouppy.Infrastructure.Llm` references the `Anthropic` package or `Microsoft.Extensions.AI`. It also fails if the adapter stops referencing the SDK, so the rule cannot pass vacuously.
- `InfrastructureBoundaryTests` holds each adapter to a row of the Blouppy projects it may reference (`An_adapter_should_reference_only_what_its_row_allows`), fails on an adapter with no row, and checks that `A_port_should_reference_no_adapter`.


## When not to write an adapter
- **The library's interface already fits.** `ILogger<T>` or `IHttpClientFactory` are abstractions already; wrapping them adds a layer and nothing else.
- **A pass-through adapter.** An interface that mirrors the SDK method for method, with the SDK's types in its signatures, translates nothing. It hides the vendor from the compiler but not from the code.
- **One caller, one vendor, no tests that need a fake.** A plain class that calls the SDK, in the one project that needs it, is enough until a second caller or a second vendor appears.

The adapter itself is cheap. The mappers are not: every new provider feature has to be added to the port, the request mapper and sometimes the stream accumulator, or it stays out of reach.


## Conclusion
The Adapter pattern is simple: implement the interface the client wants, and translate to the one the library has: requests, errors, streams. The design question is where that interface lives. A port inside the domain speaks the domain's language and serves one caller; a shared port project serves many callers and speaks the technology's; no port is fine until the second caller. [Blouppy Starter](https://starter.blouppy.com/) uses shared port projects for its technical concerns and a module-owned port for billing, and its architecture tests keep each SDK inside its adapter.


## References
- [Adapter (Refactoring.Guru)](https://refactoring.guru/design-patterns/adapter) — the pattern's structure, object and class adapters, with C# examples.
- [Hexagonal architecture (Alistair Cockburn)](https://alistair.cockburn.us/hexagonal-architecture/) — the original description of ports and adapters.
- [Dependency inversion (Microsoft Learn)](https://learn.microsoft.com/dotnet/architecture/modern-web-apps-azure/architectural-principles#dependency-inversion) — the principle behind a port declared by its caller.
- [Gateway (Martin Fowler)](https://martinfowler.com/articles/gateway-pattern.html) — an object that encapsulates access to an external system.
- [Anthropic C# SDK (GitHub)](https://github.com/anthropics/anthropic-sdk-csharp) — the SDK behind `AnthropicLlmClient`.
- [AWS SDK for .NET (AWS)](https://docs.aws.amazon.com/sdk-for-net/v3/developer-guide/welcome.html) — the SDK behind `S3FileStorage`.
- [Hexagonal architecture in .NET](/blog/2026-05-04-hexagonal-architecture-in-dotnet/) — the Starter's projects, ports and composition root.
- [A billing module behind an adapter](/blog/2026-10-01-billing-module-behind-an-adapter/) — the module that owns its payment port.
- [An AI gateway for your SaaS](/blog/2026-10-19-an-ai-gateway-for-your-saas/) — the layer that calls `ILlmClient`.
- [Architecture tests that fail the build](/blog/2026-07-03-architecture-tests-that-fail-the-build/) — the technique behind `LlmBoundaryTests`.
