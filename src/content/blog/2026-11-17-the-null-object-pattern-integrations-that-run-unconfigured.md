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

A SaaS application talks to a model provider, a payment provider, GitHub. Each needs a key, and a fresh clone has none. The first fix is a check where the client is used: `if (_client is null) return;`. Then the same check appears in a validator, a background job and a controller, one of them forgets it, and the application throws a `NullReferenceException` on a page nobody tested without the key.

In this article, we will look at the **Null Object** pattern: what it is, its minimal shape, two kinds of null object (one that does nothing and one that refuses), how the rest of the application learns that an integration is missing, and when a plain `null` is the better answer.


## The pattern
The Null Object pattern was described by Bobby Woolf in *Pattern Languages of Program Design 3*. It is outside the original Gang of Four book and is usually classed as a **behavioral** pattern, next to Strategy and State.

The idea fits in one sentence: instead of a reference that may be `null`, the caller always gets an object that implements the interface, and the "absent" case is one more implementation of it. The decision is taken once, where the object is created, and every caller stops asking.

.NET already ships a few: `Stream.Null`, `TextWriter.Null` and `NullLogger<T>.Instance` all implement their type and do nothing, so a library can log through an `ILogger` that nobody configured.


## A minimal example
Here is a service that sends a text message when the host has an SMS provider, and must work without one:

```csharp
namespace Notifications;

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

The callers inject `ISmsSender` and call it. No `ISmsSender?`, no `if`, nothing to forget. This only works because skipping a text message is acceptable, and that is the question every null object has to answer.


## Doing nothing, or refusing
A null object can answer a call in four ways:

- **A no-op**: the call returns as if it had succeeded (`Task.CompletedTask`).
- **An empty result**: a read returns an empty list, as for a customer who has nothing yet.
- **A refusal**: the call throws a dedicated exception that says what is missing.
- **A negative answer**: a check returns `false`.

The no-op is the textbook version, and it is the dangerous one. It is right when the caller does not care whether the work happened: a log line, a metric, an optional notification. It is wrong when the caller goes on as if something happened that did not: a payment taken, a model answer received, a message verified.

[Blouppy Starter](https://starter.blouppy.com/) has two integrations that run without a key, the model provider and payments, and a project-management app built on it adds two more for GitHub. Each sits behind a port with a `NotConfigured…` adapter, and none of them is a no-op.


## A null object that refuses: the model client
The AI features call a model through the `ILlmClient` port. On a server without a provider key, they get this:

```csharp
namespace Blouppy.Infrastructure.Llm;

internal sealed class NotConfiguredLlmClient : ILlmClient
{
    public bool IsConfigured
        => false;

    public string Provider
        => "None";

    public Task<LlmResponse> CompleteAsync(
        LlmRequest request,
        CancellationToken cancellationToken = default)
        => throw new LlmNotConfiguredException();

    public IAsyncEnumerable<LlmStreamEvent> StreamAsync(
        LlmRequest request,
        CancellationToken cancellationToken = default)
        => throw new LlmNotConfiguredException();
}
```

There is no sensible empty answer to "draft a description for this workspace", so every call throws `LlmNotConfiguredException` ("No language model provider is configured on this server."). An empty string returned as the model's answer would be saved, shown and charged for as if it were real.

The registration picks the adapter on every resolution, from the validated options:

```csharp
services.AddSingleton<NotConfiguredLlmClient>();

// Chosen per resolution from the validated options, so a configuration bound after this call still counts.
services.AddTransient<ILlmClient>(provider =>
    provider.GetRequiredService<IOptions<LlmOptions>>().Value.IsConfigured
        ? provider.GetRequiredService<AnthropicLlmClient>()
        : provider.GetRequiredService<NotConfiguredLlmClient>());
```

`LlmOptions.IsConfigured` is true when the provider is Anthropic and `Llm:Anthropic:ApiKey` is not empty. Deciding inside the factory rather than with an `if` around the registration means a test host that adds configuration after `AddLlmClient` still gets the adapter it configured.

The billing module has the same kind of adapter, `NotConfiguredPaymentGateway`, which refuses every payment and returns an empty invoice list. Its registration and the `503` it leads to are covered in [a billing module behind an adapter](/blog/2026-10-01-billing-module-behind-an-adapter/).


## A null object that fails closed: the webhook verifier
A project-management app built on the Starter connects to GitHub through a GitHub App, with two ports and two null objects. The web client, `NotConfiguredGitHubAppWebClient`, follows the model client: `IsConfigured` is `false` and every other member throws `GitHubAppNotConfiguredException`.

The webhook verifier is the interesting one. GitHub signs every delivery with an HMAC of the body in the `X-Hub-Signature-256` header, and the port answers one question:

```csharp
namespace Blouppy.Infrastructure.GitHub.Abstractions;

public interface IGitHubWebhookVerifier
{
    /// <summary>
    /// Checks GitHub's <c>X-Hub-Signature-256</c> header over the raw request body. False, never an
    /// exception, for anything that cannot be verified.
    /// </summary>
    bool IsValid(ReadOnlyMemory<byte> payload, string? signatureHeader);
}
```

Without a webhook secret, the real verifier has nothing to compute the HMAC with. The null object answers like this:

```csharp
namespace Blouppy.Infrastructure.GitHub.WebhookVerification;

// With no webhook secret there is nothing to verify against, so nothing is accepted.
internal sealed class NotConfiguredGitHubWebhookVerifier : IGitHubWebhookVerifier
{
    public bool IsValid(ReadOnlyMemory<byte> payload, string? signatureHeader)
        => false;
}
```

This is what **failing closed** means. The tempting "do nothing" version of a check is `return true`: nothing to verify, so let it through. On an anonymous endpoint, that turns a missing setting into an open door: anyone could post a forged event and the application would store and process it. A null object that stands in for a security check must give the answer that denies access, so that forgetting a secret costs a feature and never a breach.

It is also a second line of defence. The controller answers `404` before reading the body when the GitHub App is not configured, so the route looks absent. The verifier still refuses on its own, and a later change to the controller cannot open the endpoint by accident.


## Telling the rest of the application
A null object that throws is only safe if callers rarely reach it. The ports above carry an `IsConfigured` property for that, and each layer reads it:

- **The AI gateway** checks `IsConfigured` on the resolved client before every call and refuses with `AiRefusalReason.Unavailable`, which the API answers `503` with `ai.unavailable`. The exception of the null object is the last resort, not the normal path.
- **The UI** reads `available` from `GET /api/v1/organizations/{organizationId}/ai`, which the gateway fills from the same property. The Angular `AiAvailabilityService` exposes `isAvailable()`, and every AI entry point is placed under `@if`, so it is absent on a server without a key.
- **The GitHub validators** start with `RuleFor(x => x).Must(_ => gitHubAppWebClient.IsConfigured)`, so connecting an installation returns a validation error rather than an exception. The read side returns an empty list of link targets, and the integration's DTO carries `Configured = false`.

Billing does the same with a separate `IBillingAvailability` service instead of a property on the gateway. Either way, the question "is this integration here?" has one answer, computed once from the options.


## The danger: hiding a misconfiguration
A null object makes a missing key a supported state. That is the goal in a fresh clone, and a risk in Production: a deployment that lost its secret starts cleanly, every health check is green, and the feature is just gone.

Two things in the code base keep that visible.

**Half a configuration is an error.** `GitHubAppOptionsValidator` accepts a section where all six values are empty, and refuses one where only some are set ("set all six GitHubApp values, or none"), with `ValidateOnStart`. A typo in one variable stops the host instead of quietly falling back to the null object.

**An empty configuration is announced.** Billing registers `StripeConfigurationReport`, a hosted service that logs a warning at startup outside Development:

```csharp
namespace Blouppy.Billing.Infrastructure.Payments.Stripe;

internal sealed class StripeConfigurationReport(
    IOptions<StripeOptions> options,
    IHostEnvironment environment,
    ILogger<StripeConfigurationReport> logger) : IHostedService
{
    internal const string BillingDisabled = "Billing is disabled: Stripe:SecretKey is empty. Plans are shown, nothing can be bought";

    public Task StartAsync(CancellationToken cancellationToken)
    {
        if (!environment.IsDevelopment() && !options.Value.IsConfigured)
        {
            logger.LogWarning(BillingDisabled);
        }

        return Task.CompletedTask;
    }

    public Task StopAsync(CancellationToken cancellationToken)
        => Task.CompletedTask;
}
```

The model client and the GitHub App have no such report today. That is our advice for any null object we add: one warning line per missing integration, outside Development, so the state is read in the logs instead of discovered by a customer.


## When a plain null is better
The pattern is not a replacement for every `null`. With [nullable reference types](https://learn.microsoft.com/dotnet/csharp/nullable-references) enabled, `Customer?` is checked by the compiler, and a missing `if` is a warning, an error with `TreatWarningsAsErrors`.

Prefer `null` (or a result type) when:

- **The absence is data, not configuration.** "No customer with this id" is an answer the caller must handle. A `NullCustomer` with an empty name would end up on an invoice.
- **There is one caller.** One `if` in one place is clearer than an extra class and a registration.
- **The caller has to behave differently.** If every caller checks `IsConfigured` before each call anyway, the null object only adds a second path to keep in sync.

The Null Object pays off for a dependency that many callers use, whose absence is decided by configuration, and whose "absent" behaviour is the same everywhere.


## What it costs
- **One more class per port.** Every member added to the interface needs an answer in the null object too. The compiler makes us write one; choosing the right one is up to us.
- **A choice per member.** No-op, empty result, refusal or `false`: each one is a decision, and the wrong one hides a bug.
- **Silent degradation.** Without a validator and a startup warning, the pattern turns a missing secret into a feature that disappears without a trace.


## Conclusion
The Null Object pattern moves "is this integration here?" from every caller to one registration. The textbook version does nothing, which is right for a logger and wrong for anything the caller relies on. In the Starter and the app built on it, the null objects refuse: the model client and the GitHub client throw a dedicated exception, the payment gateway throws or returns an empty list, and the webhook verifier fails closed. An `IsConfigured` property lets the gateway, the validators and the UI avoid the call in the first place, and a validator plus a startup warning keep a missing key from passing unnoticed in Production.

This is how integrations run unconfigured in [Blouppy Starter](https://starter.blouppy.com/): a fresh clone starts with no key at all.

## References
- [Null object pattern (Wikipedia)](https://en.wikipedia.org/wiki/Null_object_pattern) — the pattern, its origin in Bobby Woolf's chapter and its relation to Special Case.
- [Special Case (Martin Fowler)](https://martinfowler.com/eaaCatalog/specialCase.html) — the broader pattern, a subclass for a particular case.
- [NullLogger&lt;T&gt; (Microsoft Learn)](https://learn.microsoft.com/dotnet/api/microsoft.extensions.logging.abstractions.nulllogger-1) — a null object shipped with .NET.
- [Nullable reference types (Microsoft Learn)](https://learn.microsoft.com/dotnet/csharp/nullable-references) — the compiler-checked alternative.
- [Options pattern in .NET (Microsoft Learn)](https://learn.microsoft.com/dotnet/core/extensions/options) — `IValidateOptions<T>` and `ValidateOnStart`.
- [Background tasks with hosted services (Microsoft Learn)](https://learn.microsoft.com/aspnet/core/fundamentals/host/hosted-services) — `IHostedService`, as used by the startup report.
- [Validating webhook deliveries (GitHub Docs)](https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries) — the `X-Hub-Signature-256` HMAC.
- [A billing module behind an adapter](/blog/2026-10-01-billing-module-behind-an-adapter/) — `NotConfiguredPaymentGateway` and `IBillingAvailability` in detail.
