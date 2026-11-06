---
templateKey: 'blog-post'
title: 'A billing module behind an adapter: Stripe that runs unconfigured'
date: 2026-10-01T09:00:00.000Z
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

Billing usually starts small: a `Plan` on the organization, a Stripe call in a controller. A few months later, `StripeConfiguration.ApiKey` is set in three places, a domain service checks `organization.Plan.Name == "Pro"`, and a fresh clone of the repository does not start without a Stripe test key. Local development needs credentials, the tests mock an SDK, and changing provider means touching the whole code base.

In this article, we will put billing in a **module** with its own `DbContext` and PostgreSQL schema, hide Stripe behind a small **payment-gateway port**, and register a **"not configured" adapter** so that the application runs, and its pricing page works, with no key at all. As a bonus, the module becomes something we can delete.


## Ask for entitlements, not plans
The first decision is not technical. The product never asks *"which plan is this organization on?"*. It asks *"what is this organization entitled to?"*.

Billing answers that question with an integration event, and the product keeps a local projection of it. Here is the contract:

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

- There is **no plan name, no price, no currency**: the product has no use for them.
- A `null` limit means unlimited.
- The fields added after the first version are last and defaulted, so a message already sitting in the outbox still deserializes.

Enforcement then never calls Billing. Let's look at how a workspace is refused past the limit, in `WorkspaceCreationValidator`:

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

The workspaces domain asks the organizations domain through its public contract, `IOrganizationsPublicDataService`, which reads the `organization_entitlements` projection. No billing call on the hot path, ever. Before the first event arrives, the product reads `FallbackEntitlements`: the Free figures, duplicated on purpose in this one place, so that creating an organization never waits on Billing.

> **_Note:_**  Only creation is checked. An organization that moves to a smaller plan keeps what it has, it just cannot add more.


## A module with its own schema
The module is a vertical slice: `Domain/` (`Plan`, `Subscription`), `Application/`, `Catalog/` and `Infrastructure/`, folded into one project, `Blouppy.Billing`. Only `Blouppy.Billing.Abstractions` is public, everything else is `internal`. The `internal` keyword, not a project per layer, is what protects the boundary.

Here is its `DbContext`:

```csharp
public class BillingDbContext(
    DbContextOptions<BillingDbContext> options)
    : DbContext(options)
{
    public const string Schema = "billing";

    internal DbSet<Plan> Plans { get; set; }
    internal DbSet<Subscription> Subscriptions { get; set; }

    protected override void OnModelCreating(ModelBuilder builder)
    {
        builder.HasDefaultSchema(Schema);
        builder.ApplyConfigurationsFromAssembly(typeof(BillingDbContext).Assembly);

        base.OnModelCreating(builder);
    }
}
```

And its registration keeps the migrations history in the same schema:

```csharp
builder.Services.AddDbContext<BillingDbContext>((serviceProvider, options) => options
    .UseNpgsql(builder.Configuration.GetConnectionString("blouppy-db"), npgsqlOptions => npgsqlOptions
        .MigrationsHistoryTable(HistoryRepository.DefaultTableName, BillingDbContext.Schema))
    .AddInterceptors(serviceProvider.GetServices<ISaveChangesInterceptor>()));
```

- Same database, two schemas: `billing` holds `plans` and `subscriptions`, the product's schema holds the projection.
- `MigrationsHistoryTable(..., BillingDbContext.Schema)` gives the module its **own migrations history**, so its migrations never collide with the application's.
- The host's save-changes interceptors are picked up by contract (`ISaveChangesInterceptor`), never by type: without them, the domain events a subscription raises would never be dispatched.

The module has no outbox of its own: `BillingUnitOfWork` borrows the application's connection and transaction, so the subscription and the entitlements message commit together. The outbox itself is explained in [Domain events vs integration events, and the transactional outbox](https://www.blouppy.com/blog/2026-05-28-domain-events-vs-integration-events-and-the-outbox/). 😉

## The port: IPaymentGateway
Now the part that keeps Stripe contained. The module declares what it needs from *whoever takes the money*, in its own vocabulary. Here is `IPaymentGateway`, trimmed:

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

    Task<IReadOnlyCollection<Invoice>> ListInvoicesAsync(
        ExternalCustomerId externalCustomerId,
        int limit,
        CancellationToken cancellationToken = default);

    Task CancelSubscriptionAsync(
        ExternalSubscriptionId externalSubscriptionId,
        CancellationToken cancellationToken = default);

    ProviderSubscriptionState? TryReadNotification(
        string payload,
        IReadOnlyDictionary<string, string> headers);
}
```

A few choices are worth noticing:
- The identifiers are `ExternalCustomerId` and `ExternalSubscriptionId`, not `StripeCustomerId`. Nothing outside the adapter says "Stripe".
- `TryReadNotification` takes **all the headers**, not a `signature` parameter: which header carries the signature stays the adapter's secret.
- It returns `null` for an authentic notification we don't act on (providers send far more event types than a subscription needs), and throws `PaymentNotificationException` for one it cannot authenticate.
- The full interface adds `ChangeSubscriptionPlanAsync` and `CreateBillingPortalSessionAsync`. Small on purpose.


## The Stripe adapter
`StripePaymentGateway` is the only type in the solution that knows Stripe exists. Let's look at how it reads a webhook:

```csharp
public ProviderSubscriptionState? TryReadNotification(
    string payload,
    IReadOnlyDictionary<string, string> headers)
{
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
- `throwOnApiVersionMismatch: false` is deliberate: a Stripe account picks its own API version, and leaving the check on makes every webhook fail the day it differs from the library's, *reported as a signature failure*. The fields read afterwards (metadata, ids, status, period end) are stable across versions.
- Three event types matter; everything else is authentic but ignored.

What comes out is a `ProviderSubscriptionState` (customer, subscription, organization, plan, status, period end, seats), already in the module's vocabulary. The organization and plan are read back from **metadata** the adapter wrote on the checkout session.

The controller in the Web project knows even less. It reads the body and the headers and hands them to `IPaymentNotificationEndpoint`, the module's only public contract that speaks HTTP:

```csharp
[AllowAnonymous]
[HttpPost("notifications", Name = RouteNames.Api.Billing.Subscriptions.Notify)]
public async Task<IActionResult> NotifyAsync(CancellationToken cancellationToken)
{
    using var reader = new StreamReader(Request.Body);

    var payload = await reader.ReadToEndAsync(cancellationToken);

    var headers = Request.Headers
        .ToDictionary(header => header.Key, header => header.Value.ToString(), StringComparer.OrdinalIgnoreCase);

    await paymentNotificationEndpoint.HandleAsync(payload, headers, cancellationToken);

    return NoContent();
}
```

The endpoint is anonymous because the signature is the credential. It acknowledges every authentic notification (the provider retries anything it does not see accepted), and an unauthenticated payload throws and becomes a `400`, never a silently accepted subscription state.


## Stripe that runs unconfigured
Here is the piece that makes local development painless. A second adapter implements the same port for the case where **no provider is configured**:

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

    // ... every other payment throws BillingNotConfiguredException
}
```

It is not a fake: every payment refuses, and the reads that have a sensible empty answer give it, so the billing page opens rather than fails. The global exception handler maps `BillingNotConfiguredException` to a `503`: the host's state, not the caller's mistake.

The module registers it by default, and `AddStripePaymentGateway` swaps it out only when a key exists:

```csharp
public IServiceCollection AddStripePaymentGateway(IConfiguration configuration)
{
    var section = configuration.GetSection(StripeOptions.SectionName);

    services
        .AddOptions<StripeOptions>()
        .Bind(section)
        .ValidateOnStart();

    services
        .AddSingleton<IValidateOptions<StripeOptions>, StripeOptionsValidator>()
        .AddHostedService<StripeConfigurationReport>();

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

- No `Stripe:SecretKey`: billing is **disabled**, which is a supported state, not a crash.
- `IBillingAvailability` is exposed by `GET /api/v1/billing/status` as `{ "paymentsEnabled": false }`, and the SPA hides every upgrade, switch, portal and cancel button.
- With a key in Production, `StripeOptionsValidator` refuses to start without a `whsec_` webhook secret and the four price ids, so a half-configured provider fails at startup, not at the first customer.

A fresh clone runs with zero credentials, and the pricing page still works. 👍


## The catalog is configuration, not seed data
If the plans lived only in Stripe, the pricing page would need Stripe. So the catalog is `Billing:Catalog`, bound to `BillingCatalogOptions`, with the default three tiers in code. A deployment overrides what differs:

```bash
Billing__Catalog__Currency=EUR
Billing__Catalog__Plans__Pro__MonthlyPrice=12
Billing__Catalog__Plans__Free__MaxWorkspaces=5
```

On every start, in every environment, `SynchronizeBillingCatalogAsync` brings the `plans` table in line. Here is the heart of `BillingCatalogSynchronizer`:

```csharp
foreach (var (type, definition) in options.Value.Plans)
{
    var wanted = BillingCatalog.CreatePlan(type, definition, options.Value.Currency);

    if (!existing.TryGetValue(type, out var plan))
    {
        added.Add(wanted);
    }
    else if (!plan.HasSameTermsAs(wanted))
    {
        plan.Revise(wanted);
        revised.Add(plan);
    }
}
```

- A missing tier is added, a changed one is revised **in place**, so the subscriptions pointing to it follow.
- A unique index on the plan type means two replicas starting together end with one row each: the loser catches the `DbUpdateException` and has nothing left to do.

Now the amount lives in two places: the catalog and the provider. They can drift. So before a checkout or a change of plan, `BillingSubscriptionService` reads the provider's price back through `TryGetPriceAsync` and throws `PriceMismatchException` when it differs from the catalog. Otherwise, the drift is only ever discovered by a customer charged an amount they were never shown.


## Testing the seam
Because the decision is made at registration, it is easy to test without a single HTTP call. Here is one of the module's tests:

```csharp
[Fact]
public void Should_leave_billing_disabled_with_the_placeholder_gateway_when_no_secret_key_is_set()
{
    // Arrange
    using var serviceProvider = Build_a_service_provider(Environments.Production, new Dictionary<string, string?> { ["Stripe:SecretKey"] = "" });
    using var scope = serviceProvider.CreateScope();

    // Act
    var availability = scope.ServiceProvider.GetRequiredService<IBillingAvailability>();
    var gateway = scope.ServiceProvider.GetRequiredService<IPaymentGateway>();

    // Assert
    availability.PaymentsEnabled
        .Should()
        .BeFalse();

    gateway
        .Should()
        .BeOfType<NotConfiguredPaymentGateway>();
}
```

The use cases mock `IPaymentGateway`, our own small interface, not the Stripe SDK. And `BillingModuleBoundaryTests` (NetArchTest) fails the build if the module ever depends on the product domain.


## Removing the module
The direction of the references is the real payoff: Billing knows the product's published contracts, the product never references Billing. So "I don't want billing" is a deletion, not a surgery:

1. Delete the `Blouppy.Billing*` projects, the wiring lines in the Web (`AddBillingModule()`, `AddStripePaymentGateway(...)`, the messaging hook, `SynchronizeBillingCatalogAsync()`), and `BillingDbContext` from the migration runner.
2. Optionally delete the entitlements consumer on the product side: it is inert without a publisher.
3. Raise `FallbackEntitlements` to unlimited.
4. Delete the billing pages in the front end.

Nothing else references the module, and the compiler proves it.


## What it costs
This shape is not free, and it's better to know it:
- **Eventual consistency**: entitlements arrive moments after the payment. Only an `Active` subscription grants anything, so a checkout grants nothing until the provider confirms it.
- **A duplicated Free tier**: `FallbackEntitlements` is the single, documented exception.
- **Seats fixed at checkout**: members joining or leaving afterwards do not change what the provider charges until the next checkout.


## Conclusion
Stripe leaks when the code asks the wrong question. By asking *"what is this organization entitled to?"* instead of *"which plan is it on?"*, the product depends on a projection, and billing becomes a module with its own `DbContext`, its own `billing` schema and its own migrations history.

Inside that module, `IPaymentGateway` speaks the module's vocabulary, `StripePaymentGateway` is the only class that knows the provider, and `NotConfiguredPaymentGateway` makes "no key" a supported state: the app starts, the pricing page works, and anything that would charge answers `503`. The catalog lives in configuration and is synchronised on every start, with the provider's price checked before charging.

This is how billing is built in [Blouppy Starter](https://starter.blouppy.com/), where the module can be removed in a few steps; its [billing module page](https://docs.starter.blouppy.com/modules/billing/) has the configuration details.

*Thanks for reading! 🙂*
