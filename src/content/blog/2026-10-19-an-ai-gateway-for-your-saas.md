---
templateKey: 'blog-post'
title: 'An AI gateway for your SaaS in ASP.NET Core: one path to the model'
date: 2026-10-19T09:00:00.000Z
updated: 2026-11-07T09:00:00.000Z
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

The first AI feature of a product is usually a few lines: inject the provider's SDK, send a prompt, return the answer. A few features later, the questions arrive: can an organization turn AI off? How much may one person use per month? Can a customer bring their own key? What did each feature cost? There is no single place to answer them, because there is no single path to the model.

In this article, we will build an **AI gateway** in ASP.NET Core: a port in front of the provider, one gateway for every call, a usage ledger, the organization's own key, and an architecture test that enforces the rule.


## The shape
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
The driven port lives in its own project, `Blouppy.Infrastructure.Llm.Abstractions`, which references nothing but the runtime:

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

Why not the provider's SDK, or [`Microsoft.Extensions.AI`](https://learn.microsoft.com/dotnet/ai/microsoft-extensions-ai), directly? With a shape of our own, a new provider is a new adapter, never a change in a feature. The [Anthropic SDK](https://docs.claude.com/en/api/client-sdks) is used inside the adapter (`AnthropicLlmClient`, calling the [Messages API](https://docs.claude.com/en/api/messages)) and nowhere else.

A fresh clone must also start without a key and say that AI is not set up: that is `NotConfiguredLlmClient`, whose `IsConfigured` is `false` and whose `CompleteAsync` and `StreamAsync` throw `LlmNotConfiguredException`. `AddLlmClient(configuration)` registers one adapter or the other, depending on whether the provider's key is set.


## What a feature hands the gateway
A feature describes a call with two records. `AiCall(OrganizationId, UserId?, AiFeature, Guid? TurnId = null)` says on whose behalf and what for. `AiPrompt` is the request without a model or an effort: a system prompt, messages, an optional JSON schema (sent as [structured outputs](https://docs.claude.com/en/docs/build-with-claude/structured-outputs)) and an output-token ceiling. The model and the effort are the feature's **configuration** (`Ai:Features:{feature}`), applied by the gateway, so no feature picks its own model.

Each `AiFeature` value has an `AiUsageKind`: an `Interactive` call is counted against the person who asked, under the organization's ceiling, and an `Automatic` one against the organization's pool.


## The checks, before anything is sent
Every call first goes through `AiGateway.AuthorizeAsync`:

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

- **The client.** `ILlmClientResolver` returns the organization's own client when it has a key its plan allows, the server's otherwise, and none when that key can no longer be decrypted.
- **The switch.** `IBuiltInAiSwitch` reads the organization's _Built-in AI_ setting on every call, so turning it off holds at once, whoever's key would pay.
- **The allowance.** Only on the server's key: the organization's own key pays its provider directly, so it is counted against nobody.
- **A refusal is not a call.** Nothing is written or charged; the gateway throws an `AiRefusedException`, which the Web turns into [problem details](https://learn.microsoft.com/aspnet/core/web-api/handle-errors) with a `code` (`ai.disabled`, `ai.personalLimitReached`...).

The same checks without a call are `GetAvailabilityAsync`, so a page never offers a call the gateway would refuse.


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

- **It never throws.** The provider has already answered and been paid, so failing the person now gains nothing; a missing row is logged as an error.
- **Only what the person could use is counted.** `AiUsageOutcome.IsCounted` is true for `Completed` and `Cancelled` (a stream they left was read in part), false for `Refused`, `Failed` and `Unusable`, which are recorded with their tokens and charged to nobody.
- **Credits, not money.** `AiCreditPricing` prices the tokens from a rate table in `AiOptions.CreditRates`, based on the provider's [per-token pricing](https://docs.claude.com/en/docs/about-claude/pricing): one credit is US$0.01 of provider cost at list price, rounded up, at least one. The month is part of each counter's key, so the monthly reset is a new row, not a job.


## The organization's own key
The key is saved encrypted through `ISecretProtector`, a port over [ASP.NET Core Data Protection](https://learn.microsoft.com/aspnet/core/security/data-protection/introduction), under a purpose of its own (`Blouppy.Ai.OrganizationAiKey.v1`); only the ciphertext and the last four characters are stored. `OrganizationLlmClientResolver` turns it back into a client, for the gateway only: it unprotects the key, asks `ILlmClientFactory` for a client, and catches `CryptographicException` to return `LlmClientResolution.OwnKeyUnreadable`.

- **Read on every call.** The key and the plan's `AllowsOwnAiKey` are read each time, so a plan change applies at once on every replica.
- **Cached per organization**, filed under the stored ciphertext, so a replaced key builds a new client.
- **Never a silent fallback.** A key that can no longer be decrypted (a database restored without its key ring) refuses the call with `ai.ownKeyUnreadable`. Falling back to the server's key would send the organization's data to another provider account and spend its plan's credits behind its back.


## Making the rule hold
"Every call goes through the gateway" is a convention until something fails the build. `LlmBoundaryTests` scans every assembly of the API host and expects exactly one type whose constructor takes an `ILlmClient`, wrapped or not (`Lazy<T>`, `Func<T>`): the gateway. Sibling tests hold the rest: only the resolver injects `ILlmClientFactory`, only the adapter references the provider SDK, and the port references nothing but `System`. That is also why the port is **not** in `Blouppy.Ai.Abstractions`, the module's contract for the Web: a controller could inject it from there and skip all three checks.


## How to add a feature
The example feature drafts a workspace description from its name:

1. **Name it**: a value in `AiFeature`, with its `AiUsageKind` (stable once shipped: the ledger stores it by name).
2. **Configure its model** in `AiOptions.Features`; `AiOptionsValidator` refuses at startup a feature without a model, or a model without a credit rate.
3. **Declare the contract** in `Blouppy.Ai.Abstractions`: `IWorkspaceDescriptionDraftService`, returning `ValidationResult<T>`.
4. **Write the prompt** as an internal static class, with the user's content escaped and fenced as data.
5. **Validate, find who pays** through a peer's public contract, **call the gateway**, register the service in `AddAiModule` and expose it in a controller.

Here is the prompt, trimmed:

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

Only the name leaves for the provider, inside a `<name>` element that the system prompt tells the model to treat as data: [XML tags](https://docs.claude.com/en/docs/build-with-claude/prompt-engineering/use-xml-tags) separate instructions from content, and escaping keeps the content from closing them, a first defense against [prompt injection](https://genai.owasp.org/llmrisk/llm01-prompt-injection/). `WorkspaceDescriptionDraftService` then finds the organization through the workspaces domain's public contract and calls `gateway.CompleteAsAsync<WorkspaceDescriptionAnswer, WorkspaceDescriptionDraft>(new AiCall(...), WorkspaceDescriptionPrompt.For(request.Name), ToDraft, logger, cancellationToken)`. `CompleteAsAsync` deserializes the JSON answer strictly against the record and runs `ToDraft` **before** the gateway records the call. So when `ToDraft` finds a description too long for the workspace and throws `new AiAnswerException(AiAnswerFailure.Unusable)`, the row says `Unusable` and nobody is charged. Notice what the service does **not** do: it checks no switch, no key and no allowance.


## Conclusion
A port of our own keeps the provider's SDK inside one adapter, and `NotConfiguredLlmClient` lets the application run without a key. One gateway checks the client, the organization's switch and the allowance on every call, then writes a ledger row of counts, never content, and an architecture test makes the rule a build failure. The cost is a little ceremony per feature: an enum value, a configuration entry, a prompt class.

This is how AI features work in [Blouppy Starter](https://starter.blouppy.com/), with the workspace description draft as the worked example. The [AI module's documentation](https://docs.starter.blouppy.com/modules/ai/) describes the allowances, the refusal codes and what is sent to the provider.

## References
- [Messages API (Anthropic)](https://docs.claude.com/en/api/messages) — the endpoint the adapter calls, with its token usage fields.
- [Client SDKs (Anthropic)](https://docs.claude.com/en/api/client-sdks) — the official SDKs, used only inside the adapter.
- [Pricing (Anthropic)](https://docs.claude.com/en/docs/about-claude/pricing) — per-token prices, including prompt caching, behind the credit rates.
- [Structured outputs (Anthropic)](https://docs.claude.com/en/docs/build-with-claude/structured-outputs) — answers constrained by a JSON schema.
- [Use XML tags to structure prompts (Anthropic)](https://docs.claude.com/en/docs/build-with-claude/prompt-engineering/use-xml-tags) — separating instructions from user content.
- [Microsoft.Extensions.AI (Microsoft Learn)](https://learn.microsoft.com/dotnet/ai/microsoft-extensions-ai) — the .NET abstraction the article compares against.
- [ASP.NET Core Data Protection (Microsoft Learn)](https://learn.microsoft.com/aspnet/core/security/data-protection/introduction) — encrypting the organization's key at rest.
- [Handle errors in ASP.NET Core APIs (Microsoft Learn)](https://learn.microsoft.com/aspnet/core/web-api/handle-errors) — problem details for refusals.
- [LLM01: Prompt injection (OWASP GenAI)](https://genai.owasp.org/llmrisk/llm01-prompt-injection/) — the risk the prompt's escaping addresses.
- [Blouppy Starter documentation: AI](https://docs.starter.blouppy.com/modules/ai/) — allowances, refusal codes and what leaves for the provider.
