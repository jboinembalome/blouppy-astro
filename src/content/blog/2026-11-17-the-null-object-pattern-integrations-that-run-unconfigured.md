---
templateKey: 'blog-post'
title: 'The Null Object pattern in C#: integrations that run unconfigured'
date: 2026-11-17T09:00:00.000Z
author: Jimmy Boinembalome
authorimage: /img/jimmy.jpg
category: C#
topic: 'Architecture'
illustration: 3
categorycolor: bg-purple-100 text-purple-800
featuredpost: true
description: >-
  Learn the Null Object pattern in C#: an adapter that stands in for a missing integration, when it should do nothing and when it must fail closed, and how to keep it honest.
tags:
  - Development
  - C#
  - Design Patterns
  - Architecture
---

A SaaS application talks to a model provider, a payment provider, GitHub. Each needs a key, and a fresh clone has none. The first fix is a check where the client is used: `if (_client is null) return;`. Then the same check appears in a validator, a background job and a controller. One of them forgets it, and a page nobody tested without the key throws a `NullReferenceException`.

The Null Object pattern takes that decision once, where the object is created.


## The pattern
Instead of a reference that may be `null`, the caller always gets an object that implements the interface. The "absent" case is one more implementation. Bobby Woolf described it in *Pattern Languages of Program Design 3*, and .NET ships a few: `Stream.Null`, `TextWriter.Null`, `NullLogger<T>.Instance`.

Here is a service that sends a text message when the host has an SMS provider, and must work without one:

```csharp
public interface ISmsSender
{
    Task SendAsync(string phoneNumber, string text, CancellationToken cancellationToken = default);
}

internal sealed class NullSmsSender : ISmsSender
{
    public Task SendAsync(string phoneNumber, string text, CancellationToken cancellationToken = default)
        => Task.CompletedTask;
}
```

The choice is made in the registration, and only there:

```csharp
var apiKey = configuration["Sms:ApiKey"];

if (string.IsNullOrWhiteSpace(apiKey))
{
    services.AddSingleton<ISmsSender, NullSmsSender>();
}
else
{
    services.AddSingleton<ISmsSender>(new ProviderSmsSender(apiKey));
}
```

The callers inject `ISmsSender` and call it. No `ISmsSender?`, no `if`, nothing to forget. This works because skipping a text message is acceptable. That is the question every null object has to answer.


## Doing nothing, or refusing
The no-op is the textbook version, and it is the dangerous one. It is right when the caller does not care whether the work happened: a log line, a metric, an optional notification. It is wrong when the caller goes on as if something happened that did not: a payment taken, a model answer received, a message verified.

[Blouppy Starter](https://starter.blouppy.com/) runs two integrations without a key, the model provider and payments. A project-management app built on it adds two more for GitHub. Each sits behind a port with a `NotConfigured…` adapter, and none of them is a no-op.

`NotConfiguredLlmClient` throws `LlmNotConfiguredException` from every call. There is no sensible empty answer to "draft a description for this workspace": an empty string would be saved, shown and charged for as if it were real. The payment gateway does the same, as told in [a billing module behind an adapter](/blog/2026-10-01-billing-module-behind-an-adapter/).

The GitHub webhook verifier is the most instructive. GitHub signs every delivery with an HMAC in the `X-Hub-Signature-256` header. Without a webhook secret, there is nothing to compute it with:

```csharp
// With no webhook secret there is nothing to verify against, so nothing is accepted.
internal sealed class NotConfiguredGitHubWebhookVerifier : IGitHubWebhookVerifier
{
    public bool IsValid(ReadOnlyMemory<byte> payload, string? signatureHeader)
        => false;
}
```

This is **failing closed**. The tempting "do nothing" version of a check is `return true`: nothing to verify, so let it through. On an anonymous endpoint, that turns a missing setting into an open door for forged events. A null object that stands in for a security check gives the answer that denies access. Forgetting a secret then costs a feature, never a breach.


## Asking before calling
A null object that throws is only safe if callers rarely reach it. So the ports carry an `IsConfigured` property, and each layer reads it. The AI gateway checks it before every call and answers `503` with `ai.unavailable`. The UI reads the same flag from the API and hides every AI entry point. The GitHub validators refuse to connect an installation with a validation error rather than an exception.

The exception in the null object is then the last resort, not the normal path. And the question "is this integration here?" has one answer, computed once from the options.


## Keeping a missing key visible
A null object makes a missing key a supported state. That is the goal in a fresh clone, and a risk in Production. A deployment that lost its secret starts cleanly, every health check is green, and the feature is just gone.

Two habits keep that visible. First, half a configuration is an error: the GitHub App's options validator accepts all six values empty, and refuses a section where only some are set, with `ValidateOnStart`. A typo stops the host instead of falling back to the null object. Second, an empty configuration is announced: billing registers a hosted service, `StripeConfigurationReport`, that logs a warning at startup outside Development when `Stripe:SecretKey` is empty. One warning line per missing integration means the state is read in the logs, not discovered by a customer.


## When a plain null is better
With [nullable reference types](https://learn.microsoft.com/dotnet/csharp/nullable-references) enabled, `Customer?` is checked by the compiler. Prefer it when the absence is data, not configuration: "no customer with this id" is an answer the caller must handle, and a `NullCustomer` with an empty name would end up on an invoice. Prefer it too when there is one caller, or when every caller has to behave differently anyway.

The Null Object pays off for a dependency that many callers use, whose absence is decided by configuration, and whose "absent" behaviour is the same everywhere.


## References
- [Null object pattern (Wikipedia)](https://en.wikipedia.org/wiki/Null_object_pattern) — the pattern, its origin and its relation to Special Case.
- [Special Case (Martin Fowler)](https://martinfowler.com/eaaCatalog/specialCase.html) — the broader pattern.
- [Validating webhook deliveries (GitHub Docs)](https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries) — the `X-Hub-Signature-256` HMAC.
- [A billing module behind an adapter](/blog/2026-10-01-billing-module-behind-an-adapter/) — `NotConfiguredPaymentGateway` and `IBillingAvailability` in detail.
