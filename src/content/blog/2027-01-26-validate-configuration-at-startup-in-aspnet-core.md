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

A missing setting rarely fails where it is missing. The SMTP host is empty, the application starts, and the health check is green. An hour later, the first password-reset e-mail throws in front of a user. Nothing read the setting until it was needed.

The fix is to read it first: bind the configuration to typed options, and validate them while the host starts.


## Bind, validate, and do it at startup
An options class is a plain class with a section name. `AddOptions<T>()` returns an `OptionsBuilder<T>`, and each call adds a step to the pipeline that builds the value:

```csharp
public sealed class SmtpOptions
{
    public const string SectionName = "Smtp";

    [Required]
    public string Host { get; set; } = string.Empty;

    [Range(1, 65535)]
    public int Port { get; set; } = 587;

    public string? Username { get; set; }

    public string? Password { get; set; }
}

builder.Services
    .AddOptions<SmtpOptions>()
    .BindConfiguration(SmtpOptions.SectionName)
    .ValidateDataAnnotations()
    .ValidateOnStart();
```

`BindConfiguration` binds the `Smtp` section. `ValidateDataAnnotations` checks the attributes. `ValidateOnStart` is the line that matters: since .NET 8, `Host.StartAsync` calls `IStartupValidator.Validate()` before it starts the hosted services. An invalid section stops the process with an `OptionsValidationException` that lists every failure.

Without `ValidateOnStart`, the same validators still run, but only when something first reads `IOptions<SmtpOptions>.Value`. That is the hour-later failure again.

Since .NET 8, `[OptionsValidator]` on an empty `partial` class lets a source generator write the attribute checks at compile time, without reflection. It only replaces the attributes, though.


## Rules between fields
Attributes check one property at a time. Real configuration has rules between properties: two settings that go together, a value required only when another one is set. That is the job of `IValidateOptions<T>`:

```csharp
internal sealed class SmtpOptionsValidator : IValidateOptions<SmtpOptions>
{
    public ValidateOptionsResult Validate(string? name, SmtpOptions options)
    {
        var failures = new List<string>();

        if (string.IsNullOrWhiteSpace(options.Username) != string.IsNullOrWhiteSpace(options.Password))
        {
            failures.Add("Smtp:Username and Smtp:Password must be set together.");
        }

        if (options.Port == 25)
        {
            failures.Add("Smtp:Port 25 is blocked by most cloud providers.");
        }

        return failures.Count == 0
            ? ValidateOptionsResult.Success
            : ValidateOptionsResult.Fail(failures);
    }
}

builder.Services.TryAddEnumerable(
    ServiceDescriptor.Singleton<IValidateOptions<SmtpOptions>, SmtpOptionsValidator>());
```

Three habits make a validator useful:

- **Collect every failure.** A deployment with three mistakes is then fixed in one round, not one per restart.
- **Name the configuration key**, as `Smtp:Username` above. It tells an operator which environment variable to set.
- **Never print a secret.** The message says the two must go together, never what they are.

`TryAddEnumerable` matters too. `AddSingleton` adds a second descriptor on every call, and a validator registered twice runs twice.

In [Blouppy Starter](https://starter.blouppy.com/), almost every rule is of this kind, so the validators are hand-written and no options class carries attributes. `AiOptionsValidator` checks that every AI feature names a model and that every model has a credit rate. A model without one would be priced at zero, so the host refuses to start rather than give away calls on the platform's key. A unit test does not need a host for this: it builds a service provider from an in-memory configuration and calls `IStartupValidator.Validate()` itself.


## Which interface to inject
`IOptions<T>` is a singleton built once. It is the right default for settings that only change with a deployment, and it is what the Starter's services inject. `IOptionsSnapshot<T>` is scoped and rebuilt for every request. `IOptionsMonitor<T>` is a singleton that sees reloads and serves **named options**, which is why ASP.NET Core's authentication handlers take it.

Live reload has a cost worth knowing. `ValidateOnStart` checks the values the host starts with. A value reloaded later is validated when it is next built, so an invalid one throws there, inside a request.


## Fail fast, or switch the integration off
Validation at startup answers "is this configuration correct?". It does not answer "is this integration required?". In a starter kit, many integrations are optional on a laptop and required in Production. The Starter uses three answers.

**Refuse to start, in Production only.** E-mail falls back to MailPit outside Production, so only Production validates at startup:

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

Note that `PostConfigure` runs before validation. A default set there is never reported as missing, which is exactly why Production skips it.

**Switch it off with a "NotConfigured" adapter.** Without `Stripe:SecretKey`, billing keeps `NotConfiguredPaymentGateway`, and every payment answers `503`. Without a model key, the AI module gets `NotConfiguredLlmClient`. "No key" is a supported state, not a validation failure. A configured key with a broken webhook secret, on the other hand, still stops a Production host.

**Start, and say so.** Some settings are valid but often wrong. A local-disk file storage outside Development logs a warning at startup: a mounted volume is fine, a container's own disk loses every file at the next deploy.

For a small service with three settings and one environment, attributes with `ValidateOnStart` are enough. And a connection string has no "NotConfigured" mode: failing fast is the only sensible behaviour.


## References
- [Options pattern in .NET (Microsoft Learn)](https://learn.microsoft.com/dotnet/core/extensions/options) — the three interfaces, named options and validation.
- [Options pattern in ASP.NET Core (Microsoft Learn)](https://learn.microsoft.com/aspnet/core/fundamentals/configuration/options) — `BindConfiguration` and `ValidateOnStart` in a web host.
- [Compile-time options validation source generation (Microsoft Learn)](https://learn.microsoft.com/dotnet/core/extensions/options-validation-generator) — `[OptionsValidator]`.
- [An AI gateway for your SaaS](/blog/2026-10-19-an-ai-gateway-for-your-saas/) — the credit ledger the AI validator protects.
