---
templateKey: 'blog-post'
title: 'The Facade pattern in C#: one door to the model'
date: 2026-11-24T09:00:00.000Z
author: Jimmy Boinembalome
authorimage: /img/jimmy.jpg
category: C#
topic: 'Architecture'
illustration: 2
categorycolor: bg-purple-100 text-purple-800
featuredpost: true
description: >-
  Learn the Facade pattern in C#: what it hides from its callers, how an architecture test makes it the only door to a subsystem, and how it differs from an adapter, a mediator and a god service.
tags:
  - Development
  - C#
  - Design Patterns
  - Architecture
---

Some operations need five collaborators to do one thing. Placing an order touches the stock, the payment and the shipping. Calling a language model in a SaaS touches the organization's settings, the person's allowance, a key, the provider and a ledger. When every caller wires those collaborators itself, each one gets the order of the steps slightly wrong, and the next caller copies the closest example it can find.

In this article, we will look at the **Facade** pattern: its shape on a small checkout example, then a real one, the AI gateway of [Blouppy Starter](https://starter.blouppy.com/). We will compare a caller with and without the facade, see how an architecture test turns the facade into the only door, and place it next to the adapter, the mediator and the god service.


## The pattern
The Facade is a **structural** pattern from the Gang of Four book. It gives a subsystem one simplified interface, so a client can use the subsystem without knowing its parts or the order in which they must be called. The parts stay where they are and keep their own interfaces; the facade only composes them.

Three things define it:

- **It owns a sequence.** The facade knows which part comes first and what happens when one of them says no.
- **It speaks the client's language.** Its methods are named after what the client wants to do.
- **It adds little logic of its own.** Each rule still lives in the part that owns it; the facade decides the order.

In the original description, a client may still reach the parts directly when it needs to. We will come back to that point, because the real example removes that option on purpose.


## A checkout facade
Here is the shape on a generic example. Three services, each with its own job:

```csharp
public interface IInventory
{
    Task<bool> TryReserveAsync(Cart cart, CancellationToken cancellationToken);

    Task ReleaseAsync(Cart cart, CancellationToken cancellationToken);
}

public interface IPayments
{
    Task<PaymentResult> ChargeAsync(CustomerId customerId, Money amount, CancellationToken cancellationToken);
}

public interface IShipping
{
    Task<ShipmentId> ScheduleAsync(Cart cart, Address address, CancellationToken cancellationToken);
}
```

The facade holds the order and the compensation, which is the part every caller would otherwise rewrite:

```csharp
internal sealed class Checkout(
    IInventory inventory,
    IPayments payments,
    IShipping shipping) : ICheckout
{
    public async Task<CheckoutResult> PlaceOrderAsync(
        Cart cart,
        Address address,
        CancellationToken cancellationToken)
    {
        if (!await inventory.TryReserveAsync(cart, cancellationToken))
        {
            return CheckoutResult.OutOfStock;
        }

        var payment = await payments.ChargeAsync(cart.CustomerId, cart.Total, cancellationToken);

        if (!payment.Succeeded)
        {
            await inventory.ReleaseAsync(cart, cancellationToken);

            return CheckoutResult.PaymentDeclined;
        }

        var shipmentId = await shipping.ScheduleAsync(cart, address, cancellationToken);

        return CheckoutResult.Placed(shipmentId);
    }
}
```

A controller now calls `PlaceOrderAsync` and handles three outcomes. It does not know that stock must be reserved before payment, or that a declined payment releases it.

For one caller and one sequence, this class is optional: a private method in the controller does the same job. The facade earns its place when several callers need the same sequence, or when skipping a step is expensive.


## What one AI call involves
Calling a model looks like one step: send a prompt, get an answer. In a multi-tenant application, it is several, and their order matters. Here is the constructor of `AiGateway`, the facade in Blouppy Starter's `Blouppy.Ai` module:

```csharp
internal sealed class AiGateway(
    ILlmClient platformClient,
    ILlmClientResolver clientResolver,
    IBuiltInAiSwitch builtInAiSwitch,
    IAiCreditAccount creditAccount,
    AiCreditPricing creditPricing,
    IAiUsageRecordsRepository usageRecordsRepository,
    IUnitOfWork unitOfWork,
    IOptions<AiOptions> options,
    ILogger<AiGateway> logger) : IAiGateway
```

That list is the subsystem. On every call, `CompleteAsync` runs it in this order:

1. **The client.** `ILlmClientResolver` returns a client built on the organization's own key (decrypted through `ISecretProtector`) when it has one its plan allows, the server's client otherwise, and no client at all when the saved key can no longer be decrypted.
2. **The checks.** No client: refused with `OwnKeyUnreadable`. A client that is not configured: `Unavailable`. The organization's _Built-in AI_ switch off: `Disabled`. Then, only on the server's key, `IAiCreditAccount.CheckAsync`: the person's own allowance for an interactive call, under the organization's ceiling, or the organization's pool for an automatic one. That can refuse with `Paused` or `PersonalLimitReached`, the second with the date the allowance comes back.
3. **The request.** The model and the effort come from the feature's configuration in `AiOptions`, never from the caller.
4. **The call** to `ILlmClient`.
5. **The ledger.** One row in `ai_usage_records`, priced and charged only on the server's key, in one commit.

A refusal in step 2 is an `AiRefusedException` carrying an `AiRefusalReason`, thrown before anything is sent; nothing is recorded and nothing is charged. A failure in step 4 is recorded as `Failed`, then thrown; when the provider rejects the organization's own key, the gateway records the call and throws a refusal with `OwnKeyRejected` instead. The [article about the AI gateway](/blog/2026-10-19-an-ai-gateway-for-your-saas/) covers each step, the credits and the ledger in detail. Here we care about what the callers no longer see.


## The caller, with and without the facade
The example feature drafts a workspace description from its name. With the facade, `WorkspaceDescriptionDraftService` validates, finds who pays, and makes one call:

```csharp
var draft = await gateway.CompleteAsAsync<WorkspaceDescriptionAnswer, WorkspaceDescriptionDraft>(
    new AiCall(organizationId, request.UserId, AiFeature.WorkspaceDescriptionDraft),
    WorkspaceDescriptionPrompt.For(request.Name),
    ToDraft,
    logger,
    cancellationToken);
```

Its dependencies are the gateway, the workspaces domain's public contract, a validator and a logger. It names a feature and builds a prompt. It never mentions a key, a switch, an allowance or a ledger.

Without the facade, the same service would need something like this. This is a sketch, not code from the repository:

```csharp
// Hypothetical: what each feature would write without the gateway.
var resolution = await clientResolver.ResolveAsync(organizationId, platformClient, cancellationToken);

if (resolution.Client is null)
{
    throw new AiRefusedException(AiRefusalReason.OwnKeyUnreadable);
}

if (!resolution.Client.IsConfigured)
{
    throw new AiRefusedException(AiRefusalReason.Unavailable);
}

if (!await builtInAiSwitch.IsEnabledAsync(organizationId, cancellationToken))
{
    throw new AiRefusedException(AiRefusalReason.Disabled);
}

if (resolution.KeySource == AiKeySource.Platform)
{
    var check = await creditAccount.CheckAsync(organizationId, request.UserId, AiUsageKind.Interactive, cancellationToken);
    // ...refuse on check.Refusal
}

var settings = options.Value.Features[AiFeature.WorkspaceDescriptionDraft];
var response = await resolution.Client.CompleteAsync(new LlmRequest { Model = settings.Model /* ... */ }, cancellationToken);

// ...price the tokens, write the usage record, charge the allowance in one commit,
// record a failure when the call throws, and never let the ledger fail the person.
```

Every line is easy. The trouble is the sum: eight dependencies per feature, and every feature responsible for the same order. A second feature that checks the allowance before the switch, or forgets to record a failed call, is a bug nobody sees in review, because each feature looks complete on its own.

The facade also hides **the shape of a failure**. `CompleteAsAsync<T, TResult>` is a C# 14 extension member on `IAiGateway` (`StructuredAnswers`) that reads the JSON answer and turns provider errors into an `AiAnswerException` with a failure the page can explain (`Busy`, `ProviderFailed`, `Declined`, `Unusable`). It runs the feature's `ToDraft` before the gateway writes the ledger row, so when `ToDraft` finds a description too long and throws `Unusable`, the row says `Unusable` and nobody is charged. The feature gets that for free by passing a function.


## Making the facade the only door
A classic facade is a convenience. A client in a hurry can still inject the parts and call them directly. For a checkout, that is a code smell. For a model, it is a call that skips the organization's switch and the ledger.

Blouppy Starter closes that door twice. First, `IAiGateway` and `AiCall` are `internal` to `Blouppy.Ai`: only the module's own features can call the gateway, and the Web reaches them through public contracts such as `IWorkspaceDescriptionDraftService`. Second, `LlmBoundaryTests` in `Blouppy.Architecture.UnitTests` checks the constructors of every type in the API host's assemblies:

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

    // Assert
    injecting
        .Should()
        .BeEquivalentTo(
            ["Blouppy.Ai.Gateway.AiGateway"],
            "a type that injects ILlmClient reaches a model without the switch, the credits or the ledger");
}
```

`Injects` also catches the client wrapped in a `Lazy<T>`, a `Func<T>`, an `IEnumerable<T>` or an array. The assemblies are found by walking the host's references, so a project added later is covered the day it is referenced. Sibling tests close the side doors: only `OrganizationLlmClientResolver` may inject `ILlmClientFactory`, which builds a client from an organization's key; only the gateway may inject `ILlmClientResolver`, which hands that client out; and only the adapter may reference the Anthropic SDK or `Microsoft.Extensions.AI`.

The expected list contains the gateway itself, which also proves the scan sees something: a test that found nothing would pass for the wrong reason. The [article on architecture tests](/blog/2026-07-03-architecture-tests-that-fail-the-build/) explains the technique in general.

With those tests, the facade is no longer a convenience. It is the subsystem's only entrance, and a feature added next year gets the checks because it has no other way in.


## A facade over a facade
The assistant needs more than a single call: a loop of rounds, each one streamed, with tools. That loop lives outside the module, in `Blouppy.Assistant`, which cannot see the internal `IAiGateway`. So the module publishes a narrower facade in `Blouppy.Ai.Abstractions`:

```csharp
internal sealed class AssistantGateway(
    IAiGateway gateway,
    IOptions<AiOptions> options) : IAssistantGateway
{
    public AssistantTurnLimits Limits
        => new(options.Value.Assistant.MaxRounds, options.Value.Assistant.MaxOutputTokensPerRound);

    public Task<IAsyncEnumerable<LlmStreamEvent>> StartRoundAsync(
        AssistantRound round,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(round);
        ArgumentOutOfRangeException.ThrowIfGreaterThan(round.Number, Limits.MaxRounds);

        var prompt = new AiPrompt
        {
            SystemPrompt = round.SystemPrompt,
            Messages = round.Messages,
            Tools = round.Tools,
            MaxOutputTokens = Limits.MaxOutputTokensPerRound,
            Caching = LlmCaching.StablePrefixAndConversation
        };

        return gateway.OpenStreamAsync(
            new AiCall(round.OrganizationId, round.UserId, AiFeature.Assistant, round.TurnId),
            prompt,
            cancellationToken);
    }
}
```

The assistant cannot choose its feature, its model or its output ceiling: `AssistantGateway` fixes them, and every round still goes through the checks and the ledger. Layering facades this way is normal. Each one narrows the interface to what its next caller is allowed to do.


## Facade, adapter, mediator
The three are often confused, because all three sit between classes:

- **An adapter** changes the shape of one interface into another the client expects. `AnthropicLlmClient` is an adapter: it turns the provider's SDK into `ILlmClient`. It adds no steps.
- **A facade** composes several parts behind a simpler interface. `AiGateway` calls five collaborators in a fixed order. The parts do not know the facade exists.
- **A mediator** (a behavioral pattern) coordinates objects that would otherwise talk to each other; they know the mediator and send through it. The switch, the credit account and the resolver never talk to one another, and none of them knows the gateway, so this is not a mediator.

A useful test: if we remove the class, does each client need one call translated (adapter), a sequence rewritten (facade), or its peers rewired (mediator)?


## When a facade becomes a god service
A facade turns into a god service when the rules move into it. `AiGateway` stays small because it owns no rule of its own: the switch is read by `IBuiltInAiSwitch`, the allowance belongs to `IAiCreditAccount`, the price to `AiCreditPricing`, the key to the resolver. The gateway decides when each is asked and what a refusal means for the call.

Signs that a facade is drifting:

- It grows methods for one caller each, such as `CompleteForWorkspaceAsync`. The workspace feature belongs in its own service, on top of the facade.
- It starts holding business decisions, like a price table or a plan check, inline.
- Its callers need options to skip steps. A facade that may skip its checks is no longer the door.

And when not to use one at all:

- **One caller, one sequence.** A private method is enough.
- **Parts that are already simple.** A facade over a single repository is an extra name for the same thing.
- **Callers that genuinely need different orders.** Forcing them through one sequence hides a real difference behind flags.

The costs are real too. A facade is one more type to read, and a closed one, like this gateway, makes the rare legitimate exception harder: a new kind of call needs a change in the facade, reviewed with care, rather than a shortcut.


## Conclusion
A facade gives a subsystem one interface named after what the client wants and keeps the order of the steps in one place. On its own, it is a convenience; with its interface kept internal and an architecture test that fails the build on any other path, it becomes the only door, and the checks hold for features nobody has written yet. Keep the rules in the parts, the sequence in the facade, and use a plain method when there is only one caller.

`AiGateway`, `AssistantGateway` and `LlmBoundaryTests` are in [Blouppy Starter](https://starter.blouppy.com/); the [AI gateway article](/blog/2026-10-19-an-ai-gateway-for-your-saas/) covers the credits, the ledger and the organization's own key.


## References
- [Facade (Refactoring.Guru)](https://refactoring.guru/design-patterns/facade) — the pattern's structure, with C# examples.
- [Adapter (Refactoring.Guru)](https://refactoring.guru/design-patterns/adapter) — the structural pattern a facade is most often confused with.
- [Mediator (Refactoring.Guru)](https://refactoring.guru/design-patterns/mediator) — the behavioral pattern for objects that would otherwise talk to each other.
- [Gateway (Martin Fowler)](https://martinfowler.com/articles/gateway-pattern.html) — an object that encapsulates access to an external system.
- [Extension members (Microsoft Learn)](https://learn.microsoft.com/dotnet/csharp/whats-new/csharp-14#extension-members) — the C# 14 syntax behind `CompleteAsAsync`.
- [An AI gateway for your SaaS in ASP.NET Core](/blog/2026-10-19-an-ai-gateway-for-your-saas/) — the gateway's checks, credits and ledger in detail.
- [Architecture tests that fail the build](/blog/2026-07-03-architecture-tests-that-fail-the-build/) — the technique behind `LlmBoundaryTests`.
