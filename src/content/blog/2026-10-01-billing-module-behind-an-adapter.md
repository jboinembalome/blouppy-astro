---
templateKey: 'blog-post'
title: 'A billing module behind an adapter: Stripe that runs unconfigured'
date: 2026-10-01T09:00:00.000Z
updated: 2026-11-07T09:00:00.000Z
author: Jimmy Boinembalome
authorimage: /img/jimmy.jpg
category: C#
topic: 'Architecture'
illustration: 3
categorycolor: bg-purple-100 text-purple-800
featuredpost: true
featuredimage: /img/billing-module-behind-an-adapter.jpg
description: >-
  Learn how to keep Stripe inside one billing module in ASP.NET Core, with its own DbContext, a payment-gateway port and an adapter that lets the app run with no key at all.
tags:
  - Development
  - C#
  - ASP.NET Core
  - EF Core
  - Stripe
  - Architecture
---

Billing usually starts small: a `Plan` on the organization, a Stripe call in a controller. A few months later, `StripeConfiguration.ApiKey` is set in three places, a domain service checks `organization.Plan.Name == "Pro"`, and a fresh clone does not start without a Stripe test key.

In this article, we will put billing in a **module** with its own `DbContext` and PostgreSQL schema, hide Stripe behind a small **payment-gateway port**, and register a **"not configured" adapter** so that the application, pricing page included, runs with no key at all. As a bonus, the module becomes something we can delete.


## Ask for entitlements, not plans
The first decision is not technical. The product never asks *"which plan is this organization on?"*. It asks *"what is this organization entitled to?"*. Billing answers with an integration event, and the product keeps a local projection of it:

```csharp
public sealed record OrganizationEntitlementsChangedIntegrationEvent(
    OrganizationId OrganizationId,
    int? MaxWorkspaces,
    DateTimeOffset EffectiveAtUtc,
    bool AllowsOwnAiKey = false,
    int? MonthlyAiCredits = null,
    int? MonthlyAiCreditsPerMember = null,
    int? MonthlyAutomationAiCredits = 0,
    bool AllowsSso = false) : IIntegrationEvent;
```

There is **no plan name, no price, no currency**, a `null` limit means unlimited, and the fields added later come last with defaults, so a message already in the outbox still deserializes.

Enforcement never calls Billing. Here is how `WorkspaceCreationValidator` refuses a workspace past the limit:

```csharp
private async Task<bool> HaveRoomForAnotherWorkspaceAsync(
    OrganizationId organizationId,
    CancellationToken cancellationToken)
{
    var entitlements = await _organizationsPublicDataService.GetEntitlementsAsync(organizationId, cancellationToken);

    // A null limit means unlimited, and costs no count query.
    if (entitlements.MaxWorkspaces is not { } maxWorkspaces)
    {
        return true;
    }

    var workspaces = await _workspacesRepository.CountByOrganizationAsync(organizationId, cancellationToken);

    return workspaces < maxWorkspaces;
}
```

The workspaces domain asks the organizations domain through its public contract, `IOrganizationsPublicDataService`, which reads the `organization_entitlements` projection: no billing call on the hot path. Before the first event arrives, it returns `FallbackEntitlements`, the Free figures duplicated on purpose in this one place, so creating an organization never waits on Billing. Only creation is checked: an organization that moves to a smaller plan keeps what it has, but cannot add more.


## A module with its own schema
The module is one project, `Blouppy.Billing`, with `Domain/` (`Plan`, `Subscription`), `Application/`, `Catalog/` and `Infrastructure/` folders. Only `Blouppy.Billing.Abstractions` is public; everything else is `internal`, and that keyword, not a project per layer, protects the boundary.

`BillingDbContext` declares `Schema = "billing"`, calls `builder.HasDefaultSchema(Schema)` and keeps its `DbSet`s `internal`. Its registration keeps the [migrations history](https://learn.microsoft.com/ef/core/managing-schemas/migrations/history-table) in the same schema:

```csharp
builder.Services.AddDbContext<BillingDbContext>((serviceProvider, options) => options
    .UseNpgsql(builder.Configuration.GetConnectionString("blouppy-db"), npgsqlOptions => npgsqlOptions
        .MigrationsHistoryTable(HistoryRepository.DefaultTableName, BillingDbContext.Schema))
    .AddInterceptors(serviceProvider.GetServices<ISaveChangesInterceptor>()));
```

- Same database, two schemas, and the module's **own migrations history**, so its migrations never collide with the application's.
- The host's [save-changes interceptors](https://learn.microsoft.com/ef/core/logging-events-diagnostics/interceptors) are picked up by contract (`ISaveChangesInterceptor`), never by type. Without them, the domain events a subscription raises would never be dispatched.

The module has no outbox of its own: `BillingUnitOfWork` borrows the application's connection and transaction, so the subscription and the entitlements message commit together (see [domain events, integration events and the outbox](https://www.blouppy.com/blog/2026-05-28-domain-events-vs-integration-events-and-the-outbox/)).


## The port: IPaymentGateway
The module declares what it needs from *whoever takes the money*, in its own vocabulary. Here is `IPaymentGateway`, trimmed:

```csharp
internal interface IPaymentGateway
{
    Task<PaymentSession> CreateCheckoutSessionAsync(
        PaymentSessionRequest request,
        CancellationToken cancellationToken = default);

    Task<ProviderPrice?> TryGetPriceAsync(
        PlanType plan,
        BillingPeriod period,
        CancellationToken cancellationToken = default);

    Task CancelSubscriptionAsync(
        ExternalSubscriptionId externalSubscriptionId,
        CancellationToken cancellationToken = default);

    ProviderSubscriptionState? TryReadNotification(
        string payload,
        IReadOnlyDictionary<string, string> headers);
}
```

- The identifiers are `ExternalCustomerId` and `ExternalSubscriptionId`: nothing outside the adapter says "Stripe".
- `TryReadNotification` takes **all the headers**, so which header carries the signature is the adapter's business. It returns `null` for an authentic notification we ignore, and throws `PaymentNotificationException` for one it cannot authenticate.
- The full interface adds `ChangeSubscriptionPlanAsync`, `ListInvoicesAsync` and `CreateBillingPortalSessionAsync`.


## The Stripe adapter
`StripePaymentGateway` is the only type in the solution that knows Stripe exists. Here is how it reads a [webhook](https://docs.stripe.com/webhooks):

```csharp
public ProviderSubscriptionState? TryReadNotification(
    string payload,
    IReadOnlyDictionary<string, string> headers)
{
    ArgumentNullException.ThrowIfNull(headers);

    if (!headers.TryGetValue(SignatureHeader, out var signature))
    {
        throw new PaymentNotificationException($"The '{SignatureHeader}' header is missing.");
    }

    Event stripeEvent;

    try
    {
        stripeEvent = EventUtility.ConstructEvent(
            payload,
            signature,
            _options.WebhookSecret,
            throwOnApiVersionMismatch: false);
    }
    catch (StripeException exception)
    {
        throw new PaymentNotificationException("The notification signature could not be verified.", exception);
    }

    return stripeEvent.Type switch
    {
        global::Stripe.EventTypes.CheckoutSessionCompleted => ReadCheckoutSession(stripeEvent),
        global::Stripe.EventTypes.CustomerSubscriptionUpdated or
        global::Stripe.EventTypes.CustomerSubscriptionDeleted => ReadSubscription(stripeEvent),
        _ => null
    };
}
```

- `EventUtility.ConstructEvent` verifies the `Stripe-Signature` header against the webhook secret.
- `throwOnApiVersionMismatch: false` is deliberate. A Stripe account picks its own [API version](https://docs.stripe.com/api/versioning), and with the check on, every webhook fails the day that version differs from the library's, *reported as a signature failure*. The fields read afterwards (metadata, ids, status, period end) are stable across versions.
- Three [subscription event types](https://docs.stripe.com/billing/subscriptions/webhooks) matter; everything else is authentic but ignored.

What comes out is a `ProviderSubscriptionState` in the module's vocabulary. The organization and plan are read back from the **metadata** the adapter wrote on the checkout session.

The Web controller knows even less: its anonymous `NotifyAsync` action reads the raw body and the headers into a case-insensitive dictionary and hands both to `IPaymentNotificationEndpoint`, the module's only public contract that speaks HTTP. The endpoint is anonymous because the signature is the credential. It acknowledges every authentic notification, since the provider retries anything it does not see accepted. An unauthenticated payload throws and becomes a `400`, never a silently accepted subscription state.


## Stripe that runs unconfigured
A second adapter implements the same port for the case where **no provider is configured**:

```csharp
internal sealed class NotConfiguredPaymentGateway : IPaymentGateway
{
    public Task<PaymentSession> CreateCheckoutSessionAsync(
        PaymentSessionRequest request,
        CancellationToken cancellationToken = default)
        => throw new BillingNotConfiguredException();

    /// <summary>No provider, so no billing history anywhere: empty, as for an organization that never paid.</summary>
    public Task<IReadOnlyCollection<Invoice>> ListInvoicesAsync(
        ExternalCustomerId externalCustomerId,
        int limit,
        CancellationToken cancellationToken = default)
        => Task.FromResult<IReadOnlyCollection<Invoice>>([]);

    // ... every other member throws BillingNotConfiguredException
}
```

It is not a fake: every payment is refused, and the reads that have a sensible empty answer return it, so the billing page opens. The global exception handler maps `BillingNotConfiguredException` to a `503`: the host's state, not the caller's mistake.

The module registers it by default, and `AddStripePaymentGateway` replaces it only when a key exists:

```csharp
public IServiceCollection AddStripePaymentGateway(IConfiguration configuration)
{
    var section = configuration.GetSection(StripeOptions.SectionName);

    // ... binds StripeOptions with ValidateOnStart and registers StripeOptionsValidator

    // Read at registration: whether a provider exists decides which gateway is registered.
    var enabled = !string.IsNullOrWhiteSpace(section[nameof(StripeOptions.SecretKey)]);

    services
        .RemoveAll<IBillingAvailability>()
        .AddSingleton<IBillingAvailability>(new BillingAvailability(PaymentsEnabled: enabled));

    if (enabled)
    {
        services
            .RemoveAll<IPaymentGateway>()
            .AddScoped<IPaymentGateway, StripePaymentGateway>();
    }

    return services;
}
```

- Without `Stripe:SecretKey`, billing is **disabled**: a supported state, not a crash.
- `GET /api/v1/billing/status` exposes `IBillingAvailability` as `{ "paymentsEnabled": false }`, and the SPA hides every upgrade, portal and cancel button.
- With a key in Production, `StripeOptionsValidator` refuses to start without a `whsec_` webhook secret and the four price ids ([options validation](https://learn.microsoft.com/dotnet/core/extensions/options) with `ValidateOnStart`), so a half-configured provider fails at startup, not at the first customer.

A unit test builds the service provider with an empty `Stripe:SecretKey` and asserts that `PaymentsEnabled` is `false` and the gateway is a `NotConfiguredPaymentGateway`, without a single HTTP call. The use cases mock `IPaymentGateway`, our own small interface, not the Stripe SDK, and `BillingModuleBoundaryTests` ([NetArchTest](https://www.nuget.org/packages/NetArchTest.Rules)) fails the build if the module ever depends on the product domain.


## The catalog is configuration, not seed data
If the plans lived only in Stripe, the pricing page would need Stripe. So the catalog is `Billing:Catalog`, bound to `BillingCatalogOptions`, with the default three tiers in code. A deployment overrides what differs:

```bash
Billing__Catalog__Currency=EUR
Billing__Catalog__Plans__Pro__MonthlyPrice=12
Billing__Catalog__Plans__Free__MaxWorkspaces=5
```

On every start, in every environment, `SynchronizeBillingCatalogAsync` brings the `plans` table in line: a missing tier is added and a changed one (`HasSameTermsAs` is false) is revised **in place**, so the subscriptions pointing to it follow. A unique index on the plan type means two replicas starting together still end with one row per tier: the loser catches the `DbUpdateException` and has nothing left to do.

The amount now lives in two places, the catalog and the provider, and they can drift. So before a checkout or a change of plan, `BillingSubscriptionService` reads the provider's price through `TryGetPriceAsync` and throws `PriceMismatchException` when it differs. Otherwise, the drift would be discovered by a customer charged an amount they were never shown.


## Removing the module
Billing knows the product's published contracts; the product never references Billing. So removing billing is a deletion: the `Blouppy.Billing*` projects, their wiring lines in the Web and the migration runner, and the billing pages, with `FallbackEntitlements` raised to unlimited. The compiler confirms that nothing else references the module.


## What it costs
- **Eventual consistency.** Entitlements arrive moments after the payment. Only an `Active` subscription grants anything, so a checkout grants nothing until the provider confirms it.
- **A duplicated Free tier.** `FallbackEntitlements` is the single, documented exception.
- **Seats fixed at checkout.** Members who join or leave afterwards do not change what the provider charges until the next checkout.


## Conclusion
Stripe leaks when the code asks the wrong question. Asking *"what is this organization entitled to?"* makes the product depend on a projection, and billing becomes a module with its own schema. Inside it, `StripePaymentGateway` is the only class that knows the provider, and `NotConfiguredPaymentGateway` makes "no key" a supported state: the app starts, the pricing page works, and anything that would charge answers `503`.

This is how billing works in [Blouppy Starter](https://starter.blouppy.com/); the [billing module page](https://docs.starter.blouppy.com/modules/billing/) has the configuration details.

## References
- [Receive Stripe events in your webhook endpoint (Stripe)](https://docs.stripe.com/webhooks) — signature verification with `Stripe-Signature` and the webhook secret.
- [Using webhooks with subscriptions (Stripe)](https://docs.stripe.com/billing/subscriptions/webhooks) — which subscription events to handle.
- [API versioning (Stripe)](https://docs.stripe.com/api/versioning) — why an account's API version can differ from the library's.
- [Stripe Checkout (Stripe)](https://docs.stripe.com/payments/checkout) — the hosted checkout session the adapter creates.
- [Migrations history table (Microsoft Learn)](https://learn.microsoft.com/ef/core/managing-schemas/migrations/history-table) — `MigrationsHistoryTable` and a history per schema.
- [EF Core interceptors (Microsoft Learn)](https://learn.microsoft.com/ef/core/logging-events-diagnostics/interceptors) — `ISaveChangesInterceptor`.
- [Options pattern in .NET (Microsoft Learn)](https://learn.microsoft.com/dotnet/core/extensions/options) — `IValidateOptions<T>` and `ValidateOnStart`.
- [NetArchTest.Rules (NuGet)](https://www.nuget.org/packages/NetArchTest.Rules) — the architecture test library.
- [Hexagonal architecture (Alistair Cockburn)](https://alistair.cockburn.us/hexagonal-architecture/) — the ports-and-adapters pattern behind `IPaymentGateway`.
- [Blouppy Starter documentation: billing](https://docs.starter.blouppy.com/modules/billing/) — the module's configuration.
