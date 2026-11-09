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
  Learn the Adapter pattern in C# on an SMS client and a real model client, and weigh three places to put the interface it implements: the domain, a shared port project, or nowhere.
tags:
  - Development
  - C#
  - Design Patterns
  - Architecture
---

A library rarely has the interface our code wants. The SDK names things its own way, throws its own exceptions and changes them between versions. When our services call it directly, those choices spread into code that should not care which vendor answers.

The Adapter pattern is the usual answer: we write the interface we want, and one class translates it to the library. The harder question comes right after, and the pattern does not answer it: **who owns that interface?**


## The pattern
The Adapter is a structural pattern from the Gang of Four. It converts the interface of a class into the one a client expects. Take a vendor SMS client we cannot change:

```csharp
// Third-party: its shape is the vendor's.
public sealed class AcmeSmsClient
{
    public AcmeSmsResult Send(string msisdn, string text, int priority) { /* ... */ }
}
```

Our code wants a typed phone number, async, and an exception of ours when the message is not sent. That is the **target**. The **adapter** implements it and calls the vendor, the **adaptee**:

```csharp
public interface ITextMessageSender
{
    Task SendAsync(PhoneNumber to, string body, CancellationToken cancellationToken = default);
}

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

This is an **object adapter**: it wraps an instance. The book also has a class adapter, which inherits from the adaptee, but SDK types are often `sealed`, so in C# we wrap.

Three patterns are easy to confuse here. An adapter changes one interface into one the client already expects. A facade offers a new, simpler interface over several parts. A decorator keeps the same interface and adds behaviour.


## What a real adapter translates
[Blouppy Starter](https://starter.blouppy.com/) calls a language model through its own port, `ILlmClient`, with `CompleteAsync` and `StreamAsync`. `AnthropicLlmClient` adapts the Anthropic SDK to it, and most of its code is translation. A mapper turns an `LlmRequest` into the SDK's parameters. An accumulator folds the provider's low-level stream events into whole text deltas and whole tool calls. And the SDK's exceptions never leave the adapter (trimmed):

```csharp
return exception switch
{
    AnthropicRateLimitException => new LlmRateLimitedException(retryAt: null),
    AnthropicUnauthorizedException or AnthropicForbiddenException
        => new LlmKeyRejectedException("Anthropic refused the API key."),
    OperationCanceledException => new LlmUnavailableException("Anthropic did not answer in time."),
    _ => new LlmUnavailableException("Anthropic could not answer.")
};
```

The SDK's exception is deliberately not kept as the inner one: its message carries the response body, and a logger writes inner exceptions too.


## Where the interface lives
The pattern says an adapter implements a target. It does not say which project declares it. There are three honest answers.

**The domain declares its port.** This is the classic reading of [hexagonal architecture](/blog/2026-05-04-hexagonal-architecture-in-dotnet/) and of dependency inversion. The code that needs a capability declares it, in its own words: `ChargeSubscription`, never `CreatePaymentIntent`. The Starter does this in one place. The billing module declares `IPaymentGateway` as an `internal` interface, and its Stripe adapter sits in the same project. Only one module takes money, so nobody else needs the port. The cost appears with a second caller: it declares a second port with a second adapter, or it reaches into the first domain.

**A port project per technical concern.** This is what the Starter does for everything else. `ILlmClient` lives in `Blouppy.Infrastructure.Llm.Abstractions`, `IEmailSender` in `Blouppy.Infrastructure.Email.Abstractions`, and each adapter sits next door. The gain is one port for several callers. `IEmailSender` serves Notifications, Organizations, Privacy and the identity host, which is a separate application. One adapter, one set of tests, one place to fix a bug. A port can also stand alone: an architecture test holds the LLM port to `System` assemblies only.

The cost is a fair objection. A shared port has no single owner, so its words drift toward the technology. `LlmRequest` speaks of output tokens and prompt caching, and no domain thinks in those terms. In the Starter, the AI module sits between the two: a feature asks for "a workspace description draft", and the module builds the `LlmRequest`. So the domain still does not see the vocabulary, but the port itself is a model client, not a domain need.

**No port at all.** A small app with one caller can call the SDK directly. No interface to keep in step, no mapper. The price comes later: tests need the SDK, its exceptions reach the callers, and changing vendor touches all of them. For a prototype or an internal tool, that price may never come.

The Starter picked shared port projects for technical concerns, for reuse across hexagons, and a module-owned port for billing. A team that wants every port named after a business need can pick the first option everywhere. Neither is the only right one. What matters is that the choice is written down and enforced.


## Keeping the SDK inside
An adapter only protects the callers if nobody walks around it. The Starter checks it with [architecture tests](/blog/2026-07-03-architecture-tests-that-fail-the-build/). One fails the build if any assembly other than the LLM adapter references the `Anthropic` package. Another holds each adapter to the projects it may reference, and checks that no port references an adapter.

When not to write one: when the library's interface already fits (`ILogger<T>`, `IHttpClientFactory`), or when the adapter would mirror the SDK method for method with the SDK's types in its signatures. That translates nothing.


## References
- [Adapter](https://refactoring.guru/design-patterns/adapter) — Refactoring.Guru: the pattern's structure, object and class adapters.
- [Hexagonal architecture](https://alistair.cockburn.us/hexagonal-architecture/) — Alistair Cockburn's original description of ports and adapters.
- [Gateway](https://martinfowler.com/articles/gateway-pattern.html) — Martin Fowler on wrapping access to an external system.
- [Architecture tests that fail the build](/blog/2026-07-03-architecture-tests-that-fail-the-build/) — the technique that keeps the SDK inside its adapter.
