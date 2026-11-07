---
templateKey: 'blog-post'
title: 'An AI gateway for your SaaS in ASP.NET Core: one path to the model'
date: 2026-10-19T09:00:00.000Z
author: Jimmy Boinembalome
authorimage: /img/jimmy.jpg
category: C#
topic: 'Architecture'
illustration: 1
categorycolor: bg-purple-100 text-purple-800
featuredpost: true
featuredimage: /img/an-ai-gateway-for-your-saas.jpg
description: >-
  Learn how to route every AI call of an ASP.NET Core application through one gateway that checks the organization's switch, the person's allowance and writes a usage ledger.
tags:
  - Development
  - C#
  - ASP.NET Core
  - AI
  - Architecture
---

The first AI feature of a product is usually a few lines: inject the provider's SDK, send a prompt, return the answer. The second one copies the first. A few features later, the questions arrive: can an organization turn AI off? How much may one person use per month? Can a customer bring their own key? What did each feature cost? There is no single place to answer them, because there is no single path to the model. And hiding the buttons is no guard: a background job would not know about it.

In this article, we will build an **AI gateway** in ASP.NET Core: a port of our own in front of the provider, one gateway that every call goes through, a usage ledger, the organization's own key, and an architecture test that makes the rule impossible to forget.


## The shape
Here is the whole idea:

```text:clipboard=false
feature ──> IAiGateway ──> ILlmClient ──> provider
              1. a client for the organization (the server's key, or its own)
              2. the organization's switch on?
              3. anything left of the allowance?
              4. the call, at the model configured for the feature
              5. the ledger row and the charge
```

A feature never sees the provider: it names itself, builds a prompt and asks the gateway.


## A port of our own
Let's start with the driven port. It lives in its own project, `Blouppy.Infrastructure.Llm.Abstractions`, which references nothing but the runtime:

```csharp
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

Why not the provider's SDK, or `Microsoft.Extensions.AI`, directly? Because the provider will change, and with a shape of our own, changing it is a new adapter, never a change in a feature. The SDK is used inside the adapter (`AnthropicLlmClient` in `Blouppy.Infrastructure.Llm`) and nowhere else.

The application also has to run without a key: a fresh clone must build, start and say that AI is not set up. That is the job of `NotConfiguredLlmClient`:

```csharp
// What a server without a provider key gets: it says so, and refuses every call.
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

    // StreamAsync throws the same way.
}
```

`AddLlmClient(configuration)` registers one or the other, depending on whether the provider's key is set.


## What a feature hands the gateway
A feature describes a call with two records. `AiCall` says on whose behalf and what for:

```csharp
internal sealed record AiCall(
    OrganizationId OrganizationId,
    UserId? UserId,
    AiFeature Feature,
    Guid? TurnId = null);
```

`AiPrompt` is the request without a model or an effort (a system prompt, messages, an optional JSON schema, an output-token ceiling). The model and the effort are the feature's **configuration**, in `AiOptions.Features` (`Ai:Features:{feature}`), and the gateway applies them. So no feature can pick its own model, and moving one to a cheaper model is a configuration change and a deploy.

`AiFeature` is an enum (`WorkspaceDescriptionDraft`, ...), and an extension block gives each value its `AiUsageKind`. An `Interactive` call is counted against the person who asked, under the organization's ceiling. An `Automatic` one (work nobody asked for at that moment) is counted against the organization's pool. A feature never chooses per call.


## The checks, before anything is sent
Here is the heart of `AiGateway`, the private method every call goes through first (lightly trimmed):

```csharp
private async Task<(ILlmClient Client, AiKeySource KeySource)> AuthorizeAsync(
    AiCall call,
    CancellationToken cancellationToken)
{
    var resolution = await clientResolver.ResolveAsync(call.OrganizationId, platformClient, cancellationToken);

    // Nothing was called, so nothing is recorded and nothing is charged.
    if (resolution.Client is null)
    {
        throw Refuse(call, AiRefusalReason.OwnKeyUnreadable);
    }

    if (!resolution.Client.IsConfigured)
    {
        throw Refuse(call, AiRefusalReason.Unavailable);
    }

    if (!await builtInAiSwitch.IsEnabledAsync(call.OrganizationId, cancellationToken))
    {
        throw Refuse(call, AiRefusalReason.Disabled);
    }

    if (resolution.KeySource == AiKeySource.Platform)
    {
        var check = await creditAccount.CheckAsync(call.OrganizationId, call.UserId, call.Feature.Kind, cancellationToken);

        if (check.Refusal is { } refusal)
        {
            throw Refuse(call, refusal, refusal == AiRefusalReason.PersonalLimitReached ? check.ResetsAt : null);
        }
    }

    return (resolution.Client, resolution.KeySource);
}
```

Let's walk through it:
- **The client.** `ILlmClientResolver` returns the organization's own client when it has a key its plan allows, the server's otherwise, and none when that key can no longer be decrypted.
- **The switch.** `IBuiltInAiSwitch` asks the organization's _Built-in AI_ setting on every call, so turning it off holds at once, for every way in. Off means off, whoever's key would pay.
- **The allowance.** Only on the server's key: the organization's own key pays its provider directly, so it is counted against nobody.
- **A refusal is not a call.** Nothing is written and nothing is charged; the gateway only logs it and throws an `AiRefusedException` with a reason.

The Web's `GlobalExceptionHandler` turns each reason into problem details with a `code` (`ai.disabled`, `ai.paused`, `ai.personalLimitReached`, `ai.unavailable`...), so the front end can say what the person can do about it instead of a generic error.

The same checks, asked without calling anything, are `GetAvailabilityAsync`, so a page never offers a call the gateway would refuse.


## The ledger, after the answer
Once the provider has answered, the gateway writes one row in `ai_usage_records`: organization, user, feature, key source, provider, model, the four token counts, credits and outcome. **Counts, never content**: the prompt and the answer are not kept. Here is the core of `RecordAsync`, simplified:

```csharp
try
{
    var tokens = new AiTokenCounts(usage.InputTokens, usage.OutputTokens, usage.CacheReadTokens, usage.CacheWriteTokens);

    // The organization's own key pays its provider directly: the call is recorded, never charged.
    var isCharged = keySource == AiKeySource.Platform && outcome.IsCounted;

    var credits = isCharged
        ? creditPricing.PriceOf(requestedModel, model, tokens)
        : 0;

    var record = new AiUsageRecord(
        call.OrganizationId, call.UserId, call.Feature, keySource, provider, model,
        tokens, credits, outcome, call.TurnId, Stopwatch.GetElapsedTime(startedAt));

    // Not the caller's token: the call happened whether or not the caller stayed for the answer.
    await usageRecordsRepository.AddAsync(record, CancellationToken.None);

    // ...then one commit, charging the allowance when isCharged.
}
catch (Exception exception)
{
    logger.LogError(exception, "Could not record a {Feature} call ...", call.Feature /* ... */);
}
```

A few decisions hide in these lines:
- **It never throws.** By then the provider has answered and been paid, so failing the person now would gain nothing; a missing row is logged as an error.
- **Only what the person could use is counted.** `AiUsageOutcome.IsCounted` is true for `Completed` and `Cancelled` (a stream they left was read in part), false for `Refused`, `Failed` and `Unusable`, which are recorded with their tokens and charged to nobody.
- **Credits, not money.** `AiCreditPricing` prices the tokens from a rate table in `AiOptions.CreditRates`: one credit is US$0.01 of provider cost at list price, rounded up, at least one. A new model is a row in the table; past rows stay as they are.

Allowances are checked before the call and charged after, never past what is left. And the month is part of each counter's key, so the monthly reset is a new row, not a job. 👍


## The organization's own key
Bring-your-own-key is where a direct SDK call would really hurt. Here, the key is saved encrypted through `ISecretProtector`, a port over ASP.NET Core Data Protection:

```csharp
var key = new ProtectedAiKey(
    secretProtector.Protect(OrganizationAiKeys.ProtectionPurpose, edition.ApiKey),
    AiRules.ApiKeySuffixOf(edition.ApiKey));
```

Only the ciphertext and the last four characters are stored, under a purpose of its own (`Blouppy.Ai.OrganizationAiKey.v1`).

`OrganizationLlmClientResolver` turns it back into a client, for the gateway only:

```csharp
try
{
    var client = organizationClients.GetOrAdd(
        organizationId,
        organizationAiKey.ProtectedValue,
        () => clientFactory.Create(
            organizationAiKey.Provider.ToString(),
            secretProtector.Unprotect(OrganizationAiKeys.ProtectionPurpose, organizationAiKey.ProtectedValue)));

    return new LlmClientResolution(client, AiKeySource.Organization);
}
catch (CryptographicException)
{
    return LlmClientResolution.OwnKeyUnreadable;
}
```

- **Read on every call**: the key and the plan's `AllowsOwnAiKey` are read each time, so a plan change applies at once on every replica.
- **Cached per organization** by `OrganizationLlmClients`, filed under the stored key, so a replaced key builds a new client.
- **Never a silent fallback.** A key that can no longer be decrypted (a database restored without its key ring) refuses the call with `ai.ownKeyUnreadable`. Sending it on the server's key would take the organization's data to another provider account and spend its plan's credits behind its back.


## Making the rule hold
"Every call goes through the gateway" is a convention until something fails the build. `LlmBoundaryTests`, in `Blouppy.Architecture.UnitTests`, scans every assembly the API host is composed of, found by walking its references:

```csharp
[Fact]
public void Only_the_gateway_should_inject_a_model_client()
{
    // Act
    var injecting = HostAssemblies
        .SelectMany(LoadableTypes)
        .Where(x => Injects(x, dependency => dependency == typeof(ILlmClient)))
        .Select(x => x.FullName!)
        .ToArray();

    // Assert — the gateway itself is expected, which is also what proves the scan sees anything.
    injecting
        .Should()
        .BeEquivalentTo(
            [GatewayName],
            "a type that injects ILlmClient reaches a model without the switch, the credits or the ledger");
}
```

`Injects` looks at constructor parameters, wrapped ones included (`Lazy<T>`, `Func<T>`...). Sibling tests hold the rest: only the resolver injects `ILlmClientFactory`, only the adapter references the provider SDK, and the port references nothing but `System`.

That is also why the port is **not** in `Blouppy.Ai.Abstractions`, the module's contract for the Web: a controller could inject it from there and skip all three checks. 😉


## How to add a feature
The code base ships one small example, a workspace description drafted from its name. Here is the recipe it follows:

1. **Name it**: a value in `AiFeature`, and its `AiUsageKind` in the switch beside it. The ledger stores it by name, so it is stable once shipped.
2. **Configure its model** in `AiOptions.Features`. `AiOptionsValidator` refuses, at start, a feature without a model and a model without a credit rate.
3. **Declare the contract** in `Blouppy.Ai.Abstractions`: `IWorkspaceDescriptionDraftService`, returning `ValidationResult<T>` like any write.
4. **Write the prompt** as an internal static class: the system prompt, the user's content escaped and fenced as data, a JSON schema and an output-token ceiling.
5. **Validate**, **find who pays** through a peer's public contract, **call the gateway**, register the service in `AddAiModule`, expose it in a controller.

Here is the prompt of the example, trimmed:

```csharp
public static AiPrompt For(string name)
    => new()
    {
        SystemPrompt = SystemPrompt,
        Messages = [LlmMessage.User($"<name>{Escape(name.Trim())}</name>")],
        ResponseSchemaJson = ResponseSchemaJson,
        MaxOutputTokens = MaxOutputTokens
    };

// What the team wrote cannot close the tag and speak as the prompt.
private static string Escape(string text)
    => text
        .Replace("&", "&amp;", StringComparison.Ordinal)
        .Replace("<", "&lt;", StringComparison.Ordinal)
        .Replace(">", "&gt;", StringComparison.Ordinal);
```

Only the name leaves for the provider, inside a `<name>` element the system prompt tells the model to treat as data. And here is the call, from `WorkspaceDescriptionDraftService`:

```csharp
var organizationId = await workspacesPublicDataService.TryGetOrganizationIdAsync(request.WorkspaceId, cancellationToken);

var draft = await gateway.CompleteAsAsync<WorkspaceDescriptionAnswer, WorkspaceDescriptionDraft>(
    new AiCall(organizationId, request.UserId, AiFeature.WorkspaceDescriptionDraft),
    WorkspaceDescriptionPrompt.For(request.Name),
    ToDraft,
    logger,
    cancellationToken);

return ValidationResult.Success(draft);
```

`CompleteAsAsync` (in `StructuredAnswers`) deserializes the JSON answer strictly against the record, and runs `ToDraft` **before** the gateway records the call. So when `ToDraft` finds a description too long for the workspace and throws `new AiAnswerException(AiAnswerFailure.Unusable)`, the row says `Unusable` and nobody is charged for an answer they could not use.

Notice what the service does **not** do: it checks no switch, no key and no allowance.


## Conclusion
Calling a provider directly from each feature is easy for the first one and expensive by the fifth. A port of our own (`ILlmClient`) keeps the SDK inside one adapter, and `NotConfiguredLlmClient` lets the application run without a key. One gateway then asks, on every call and in order, for a client, the organization's switch and the allowance, before writing a ledger row of counts, never content.

Bring-your-own-key fits in the same path: encrypted through `ISecretProtector`, resolved per call, never silently replaced by the server's key. And an architecture test makes "only the gateway injects `ILlmClient`" a build failure rather than a review comment. The cost is a little ceremony per feature: an enum value, a configuration entry, a prompt class. In exchange, the next feature cannot forget the rules.

This is how AI features are built in [Blouppy Starter](https://starter.blouppy.com/), with the workspace description draft as the worked example. The [AI module's documentation](https://docs.starter.blouppy.com/modules/ai/) describes the allowances, the refusal codes and what is sent to the provider.

*Thanks for reading! 🙂*
