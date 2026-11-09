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

Some operations need several collaborators to do one thing. Placing an order touches the stock, the payment and the shipping. When every caller wires those collaborators itself, each one gets the order of the steps slightly wrong, and the next caller copies the closest example it can find.

The Facade pattern puts that sequence in one place.


## The pattern
The Facade is a structural pattern from the Gang of Four book. It gives a subsystem one simplified interface, named after what the client wants to do. The parts stay where they are and keep their own interfaces. The facade only composes them: it knows which part comes first and what happens when one says no.

A checkout shows the shape:

```csharp
internal sealed class Checkout(
    IInventory inventory,
    IPayments payments,
    IShipping shipping) : ICheckout
{
    public async Task<CheckoutResult> PlaceOrderAsync(Cart cart, Address address, CancellationToken cancellationToken)
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

A controller now calls `PlaceOrderAsync` and handles three outcomes. It does not know that stock is reserved before payment, or that a declined payment releases it. That compensation is exactly the part every caller would otherwise rewrite.

For one caller and one sequence, this class is optional: a private method does the same job. The facade earns its place when several callers need the same sequence, or when skipping a step is expensive.


## When skipping a step is expensive
Calling a language model in a multi-tenant SaaS is such a case. Before the call, the server picks a client: the organization's own key or the server's. It checks the organization's _Built-in AI_ switch, and the person's monthly allowance on the server's key. After the call, it writes a row to a usage ledger and charges the allowance. A feature that forgets the switch, or checks the allowance in the wrong order, is a bug nobody sees in review, because each feature looks complete on its own.

In [Blouppy Starter](https://starter.blouppy.com/), `AiGateway` owns that sequence. A feature that drafts a workspace description names itself, builds a prompt, and makes one call:

```csharp
var draft = await gateway.CompleteAsAsync<WorkspaceDescriptionAnswer, WorkspaceDescriptionDraft>(
    new AiCall(organizationId, request.UserId, AiFeature.WorkspaceDescriptionDraft),
    WorkspaceDescriptionPrompt.For(request.Name),
    ToDraft,
    logger,
    cancellationToken);
```

It never mentions a key, a switch, an allowance or a ledger. The model and its settings come from the feature's configuration, not from the caller. A refusal is thrown before anything is sent, and nothing is charged. The details of each step are in [an AI gateway for your SaaS](/blog/2026-10-19-an-ai-gateway-for-your-saas/).


## Making it the only door
A classic facade is a convenience. A client in a hurry can still inject the parts and call them directly. For a checkout, that is a code smell. For a model, it is a call that skips the switch and the ledger.

The Starter closes that door twice. First, `IAiGateway` is `internal` to the AI module, so only the module's own features can call it. Second, an architecture test scans the constructors of every type in the API host's assemblies. Simplified:

```csharp
[Fact]
public void Only_the_gateway_should_inject_a_model_client()
{
    var injecting = HostAssemblies
        .SelectMany(LoadableTypes)
        .Where(x => Injects(x, dependency => dependency == typeof(ILlmClient)))
        .Select(x => x.FullName!)
        .ToArray();

    injecting
        .Should()
        .BeEquivalentTo(["Blouppy.Ai.Gateway.AiGateway"]);
}
```

`Injects` also catches the client wrapped in a `Lazy<T>`, a `Func<T>` or a collection. The expected list contains the gateway itself, which proves the scan sees something: a test that found nothing would pass for the wrong reason. Sibling tests close the side doors, such as the factory that builds a client from an organization's key. The technique is explained in [architecture tests that fail the build](/blog/2026-07-03-architecture-tests-that-fail-the-build/).

With that test, the facade is no longer a convenience. A feature added next year gets the checks because it has no other way in.


## Facade, adapter, mediator
The three sit between classes, and are often confused. An **adapter** changes one interface into another: the Anthropic client turns the provider's SDK into `ILlmClient`, and adds no step. A **facade** composes several parts behind a simpler interface, and the parts do not know it exists. A **mediator** coordinates objects that would otherwise talk to each other, and they all know it. The switch, the credit account and the key resolver never talk to one another, so the gateway is not a mediator.


## When a facade becomes a god service
A facade turns into a god service when the rules move into it. `AiGateway` stays small because it owns no rule of its own. The switch, the allowance, the price and the key each belong to their own service. The gateway decides when each one is asked.

Watch for the drift. A method for one caller, such as `CompleteForWorkspaceAsync`, belongs in a service on top of the facade. A price table inline is a rule that left its part. And a caller that needs an option to skip a step means the facade is no longer the door.


## References
- [Facade (Refactoring.Guru)](https://refactoring.guru/design-patterns/facade) — the pattern's structure, with C# examples.
- [Gateway (Martin Fowler)](https://martinfowler.com/articles/gateway-pattern.html) — an object that encapsulates access to an external system.
- [An AI gateway for your SaaS in ASP.NET Core](/blog/2026-10-19-an-ai-gateway-for-your-saas/) — the gateway's checks, credits and ledger in detail.
- [Architecture tests that fail the build](/blog/2026-07-03-architecture-tests-that-fail-the-build/) — the technique behind the boundary test.
