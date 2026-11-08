---
templateKey: 'blog-post'
title: 'Validate configuration at startup in ASP.NET Core'
date: 2027-01-26T09:00:00.000Z
author: Jimmy Boinembalome
authorimage: /img/jimmy.jpg
category: C#
topic: 'C# & .NET'
illustration: 3
categorycolor: bg-purple-100 text-purple-800
featuredpost: true
description: >-
  Learn how to bind and validate options at startup in ASP.NET Core, write cross-field validators, pick between IOptions, IOptionsSnapshot and IOptionsMonitor, and decide when to fail fast.
tags:
  - Development
  - C#
  - ASP.NET Core
---

A missing setting rarely fails where it is missing. The SMTP host is empty, the application starts, the health check is green, and the first password-reset e-mail throws an exception an hour later, in front of a user. A typo in a price id does the same at the first checkout. Nothing read the setting until it was needed.

In this article, we will bind configuration to typed options, validate it when the host starts with `ValidateOnStart`, write cross-field rules with `IValidateOptions<T>`, look at the source-generated `[OptionsValidator]`, choose between `IOptions<T>`, `IOptionsSnapshot<T>` and `IOptionsMonitor<T>`, and decide when a missing setting should stop the host and when it should switch an optional integration off.


## The options pattern in one example
An options class is a plain class with a section name. `AddOptions<T>()` returns an `OptionsBuilder<T>`, and each call on it adds one step to the pipeline that builds the value:

```csharp
public sealed class SmtpOptions
{
    public const string SectionName = "Smtp";

    [Required]
    public string Host { get; set; } = string.Empty;

    [Range(1, 65535)]
    public int Port { get; set; } = 587;
}

builder.Services
    .AddOptions<SmtpOptions>()
    .BindConfiguration(SmtpOptions.SectionName)
    .ValidateDataAnnotations()
    .ValidateOnStart();
```

- `BindConfiguration` binds the section from the `IConfiguration` registered in the container. `Bind(section)` does the same with a section we pass ourselves.
- `ValidateDataAnnotations` registers a validator that checks the `System.ComponentModel.DataAnnotations` attributes of the class.
- `ValidateOnStart` asks the host to build and validate the options while it starts. Since .NET 8, `Host.StartAsync` calls `IStartupValidator.Validate()` before it starts the hosted services, so an invalid section stops the process with an `OptionsValidationException` that lists every failure.

Without `ValidateOnStart`, the same validators still run, but only when something first reads `IOptions<SmtpOptions>.Value`.

For a single rule, `Validate` takes a predicate and a message, and runs after binding and after any `PostConfigure`:

```csharp
builder.Services
    .AddOptions<SmtpOptions>()
    .BindConfiguration(SmtpOptions.SectionName)
    .Validate(options => options.Port != 25, "Smtp:Port 25 is blocked by most cloud providers.")
    .ValidateOnStart();
```


## Cross-field rules with IValidateOptions
Attributes check one property at a time. Real configuration has rules between properties: two settings that go together, a value required only when another one is set, a key that must exist in a dictionary because another section names it. That is the job of `IValidateOptions<T>`:

```csharp
public interface IValidateOptions<TOptions> where TOptions : class
{
    ValidateOptionsResult Validate(string? name, TOptions options);
}
```

It returns `ValidateOptionsResult.Success`, `Fail(...)` with one or more messages, or `Skip` when the validator does not apply to that named instance. Validators are registered as services, so a class can take dependencies and several validators can check the same type.

Here is the shape of `AiOptionsValidator` in [Blouppy Starter](https://starter.blouppy.com/), trimmed. The AI module maps each feature to a model and each model to a credit rate, and the two dictionaries must agree:

```csharp
internal sealed class AiOptionsValidator : IValidateOptions<AiOptions>
{
    public ValidateOptionsResult Validate(string? name, AiOptions options)
    {
        var failures = new List<string>();

        foreach (var feature in Enum.GetValues<AiFeature>())
        {
            var key = $"{AiOptions.SectionName}:{nameof(AiOptions.Features)}:{feature}";

            if (!options.Features.TryGetValue(feature, out var settings) || string.IsNullOrWhiteSpace(settings.Model))
            {
                failures.Add($"{key}:{nameof(AiFeatureOptions.Model)} is missing.");

                continue;
            }

            if (!options.CreditRates.ContainsKey(settings.Model))
            {
                failures.Add($"{AiOptions.SectionName}:{nameof(AiOptions.CreditRates)}:{settings.Model} is missing: {key} uses it.");
            }
        }

        return failures.Count == 0
            ? ValidateOptionsResult.Success
            : ValidateOptionsResult.Fail(failures);
    }
}
```

And its registration:

```csharp
services
    .AddOptions<AiOptions>()
    .Bind(configuration.GetSection(AiOptions.SectionName))
    .ValidateOnStart();

services.AddSingleton<IValidateOptions<AiOptions>, AiOptionsValidator>();
```

Three habits make these validators useful:

- **Collect every failure.** The validator returns a list, so a deployment with three mistakes fixes three in one round instead of one per restart.
- **Name the configuration key.** `Ai:CreditRates:claude-opus-6 is missing: Ai:Features:WorkspaceDescriptionDraft uses it` tells an operator which environment variable to set. A message about a property name does not.
- **Never print a secret.** `EmailOptionsValidator` says the SMTP username and password "must be set together", never what they are.

The same validator also guards the money. A feature whose model has no credit rate would be priced at zero, so the host refuses to start rather than give away calls on the platform's key (the [AI gateway](/blog/2026-10-19-an-ai-gateway-for-your-saas/) article explains the ledger behind it). The billing catalog follows the same idea: `BillingCatalogOptionsValidator` checks that `Billing:Catalog` has every tier, no negative price and a real currency code, by building each plan with the same factory the module uses at runtime and turning its `ArgumentException` into a failure.

Unit tests do not need a host. `IStartupValidator` is a public service, so a test builds a service provider from an in-memory configuration and calls it:

```csharp
var act = () => serviceProvider.GetRequiredService<IStartupValidator>().Validate();

act.Should()
    .Throw<OptionsValidationException>()
    .Which.Failures
    .Should()
    .ContainSingle(x => x.Contains("Ai:CreditRates:claude-opus-6"));
```


## The source-generated validator
`ValidateDataAnnotations` uses reflection to read the attributes. Since .NET 8, the `[OptionsValidator]` attribute lets a source generator write the same checks at compile time, which also works with trimming and Native AOT:

```csharp
[OptionsValidator]
public sealed partial class SmtpOptionsValidator : IValidateOptions<SmtpOptions>
{
}

builder.Services
    .AddOptions<SmtpOptions>()
    .BindConfiguration(SmtpOptions.SectionName)
    .ValidateOnStart();

builder.Services.AddSingleton<IValidateOptions<SmtpOptions>, SmtpOptionsValidator>();
```

The class is `partial` and empty: the generator writes its `Validate` method from the attributes of `SmtpOptions`. Nested objects are validated when their property carries `[ValidateObjectMembers]`, and the items of a collection when it carries `[ValidateEnumeratedItems]`.

It only replaces the attribute checks. A rule between two fields still goes in a hand-written `IValidateOptions<T>`, next to the generated one. In the Starter, almost every rule is a cross-field rule, so the validators are hand-written and no options class carries attributes.


## IOptions, IOptionsSnapshot or IOptionsMonitor
The three interfaces read the same pipeline. They differ in lifetime and in when the value is rebuilt:

| Interface | Lifetime | Value | Reloads |
| --- | --- | --- | --- |
| `IOptions<T>` | Singleton | Built once, on first read | Never |
| `IOptionsSnapshot<T>` | Scoped | Built once per scope (per request) | Yes, at the next scope |
| `IOptionsMonitor<T>` | Singleton | `CurrentValue`, cached | Yes, after a change, with `OnChange` |

- `IOptions<T>` is the default, and the one the Starter's services inject. Most settings (an SMTP host, a model name, a price id) only change with a deployment.
- `IOptionsSnapshot<T>` cannot be injected into a singleton, and it rebuilds the options for every request, validators included.
- `IOptionsMonitor<T>` is for singletons that must see a change without a restart, and for **named options**: `Get(name)` returns one instance per name. That is why ASP.NET Core's authentication handlers take `IOptionsMonitor<AuthenticationSchemeOptions>`, and why the Starter's handlers for introspected tokens and SCIM do the same.

`ValidateOnStart` checks the values the host starts with. With a reloading provider, a later value goes through the validators when it is next built, and an invalid one throws there, inside a request or a change callback. Live reload moves the failure back to runtime.


## Fail fast, or switch the integration off
Validation at startup answers "is this configuration correct?". It does not answer "is this integration required?". In a SaaS starter, many integrations are optional on a developer's laptop and required in Production. The Starter uses three answers.

**Refuse to start in Production.** E-mail falls back to MailPit outside Production, and only Production validates at startup:

```csharp
var options = services
    .AddOptions<EmailOptions>()
    .Bind(configuration.GetSection(EmailOptions.SectionName))
    .PostConfigure(x =>
    {
        // Production gets no fallback: a missing setting must stop the host, not send to MailPit.
        if (environment.IsProduction())
        {
            return;
        }

        DevelopmentEmailDefaults.Apply(x, configuration.GetConnectionString(MailPitConnectionName));
    });

if (environment.IsProduction())
{
    options.ValidateOnStart();
}
```

Stripe goes one step further: `StripeOptionsValidator` takes `IHostEnvironment` in its constructor and returns `Success` unless a secret key is set **and** the environment is Production. Then it requires a `whsec_` webhook secret and a price id for every paid plan and period, because each gap would otherwise surface as the first customer's failure.

**Switch the integration off with a "NotConfigured" adapter.** Without `Stripe:SecretKey`, the module keeps `NotConfiguredPaymentGateway`, and every payment answers `503` (the [billing module](/blog/2026-10-01-billing-module-behind-an-adapter/) article covers it). The model provider does the same with `NotConfiguredLlmClient`, chosen when the client is resolved from the validated options:

```csharp
services.AddTransient<ILlmClient>(provider =>
    provider.GetRequiredService<IOptions<LlmOptions>>().Value.IsConfigured
        ? provider.GetRequiredService<AnthropicLlmClient>()
        : provider.GetRequiredService<NotConfiguredLlmClient>());
```

"No key" is a supported state, so it is not a validation failure. What is validated is the rest: a configured key with a broken webhook secret still stops the host.

**Start, and say so.** Some settings are acceptable in Production but often wrong. When `FileStorage:Provider` is the local disk outside Development, `LocalDiskStorageWarning`, a hosted service, logs a warning at startup: a single instance on a mounted volume is valid, and a container's own disk loses every file at the next deploy. `StripeConfigurationReport` logs a test key in Production, because a staging box run as Production is legitimate. The Data Protection certificate follows the same path with an exit: without `DataProtection:Certificate`, Production logs that the key ring is stored unencrypted, and `DataProtection:RequireEncryption` turns that warning into a refusal once a certificate is in place.


## Pitfalls
- **A validator registered twice runs twice.** `AddSingleton` adds a second descriptor each time. The e-mail adapter registers its validator with `TryAddEnumerable`, so two hosts or two calls cannot duplicate it.
- **Reading configuration during registration skips validation.** Sometimes the value decides which services exist: `FileStorage:Provider` picks `S3FileStorage` or `LocalDiskFileStorage`, and `Stripe:SecretKey` picks the gateway. These are read directly from the section, before the options exist. Keep that read to the one switch, and leave everything else to the validated options.
- **`PostConfigure` runs before validation.** That is useful (the Starter turns a relative `FileStorage:RootPath` into an absolute one first), but a default set there is never reported as missing.
- **`ValidateOnStart` only covers what the host starts.** A console tool or a test that builds a service provider by hand has no `Host.StartAsync`: call `IStartupValidator.Validate()` yourself.


## When it is not worth it
For a small internal service with three settings and one environment, `[Required]` attributes with `ValidateDataAnnotations().ValidateOnStart()` are enough, and a hand-written validator adds code nobody reads. The same goes for a value with a safe default: validation pays off for settings that are required, related to one another, or expensive to get wrong. And a "NotConfigured" adapter only makes sense for an integration the product can live without. For a database connection string, failing fast is the only sensible behaviour.


## Conclusion
Configuration fails at the first read, so the fix is to read it first. `BindConfiguration` and `ValidateOnStart` move every check to the moment the host starts, `IValidateOptions<T>` holds the rules between fields with messages that name the keys, and `[OptionsValidator]` replaces reflection for attribute checks. `IOptions<T>` is enough for settings that change with a deployment; `IOptionsMonitor<T>` is for reloads and named options. On top of that, decide per integration whether a gap stops the host, switches the feature off, or logs a warning. That decision is what keeps a fresh clone running with no keys, and a Production host from starting with half of them.

This is how configuration is validated in [Blouppy Starter](https://starter.blouppy.com/), and a project-management app built on the Starter follows the same rules.


## References
- [Options pattern in .NET (Microsoft Learn)](https://learn.microsoft.com/dotnet/core/extensions/options) — `IOptions<T>`, `IOptionsSnapshot<T>`, `IOptionsMonitor<T>`, named options and validation.
- [Options pattern in ASP.NET Core (Microsoft Learn)](https://learn.microsoft.com/aspnet/core/fundamentals/configuration/options) — `BindConfiguration`, `ValidateDataAnnotations` and `ValidateOnStart` in a web host.
- [Compile-time options validation source generation (Microsoft Learn)](https://learn.microsoft.com/dotnet/core/extensions/options-validation-generator) — `[OptionsValidator]`, `[ValidateObjectMembers]` and `[ValidateEnumeratedItems]`.
- [Configuration in ASP.NET Core (Microsoft Learn)](https://learn.microsoft.com/aspnet/core/fundamentals/configuration/) — the providers and how environment variables map to section keys.
- [Configure ASP.NET Core Data Protection (Microsoft Learn)](https://learn.microsoft.com/aspnet/core/security/data-protection/configuration/overview) — `ProtectKeysWithCertificate` and encrypting the key ring at rest.
- [Hexagonal architecture in .NET](/blog/2026-05-04-hexagonal-architecture-in-dotnet/) — the ports and adapters behind the "NotConfigured" adapters.
