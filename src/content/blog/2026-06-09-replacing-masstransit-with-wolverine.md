---
templateKey: 'blog-post'
title: 'Replacing MassTransit with Wolverine: keep the bus library in one project'
date: 2026-06-09T09:00:00.000Z
updated: 2026-11-07T09:00:00.000Z
author: Jimmy Boinembalome
authorimage: /img/jimmy.jpg
category: C#
topic: 'Messaging'
illustration: 2
categorycolor: bg-purple-100 text-purple-800
featuredpost: true
featuredimage: /img/replacing-masstransit-with-wolverine.jpg
description: >-
  Learn how to put your message bus behind ports and adapters, so that replacing MassTransit with Wolverine means rewriting one adapter instead of every domain.
tags:
  - Development
  - C#
  - ASP.NET Core
  - Architecture
  - Wolverine
  - RabbitMQ
---

MassTransit's v9 is a [commercial release](https://masstransit.massient.com/), so staying free means staying on the 8.x line. For many .NET teams, that raises an uncomfortable question: how many projects actually know which message bus we use? If the answer is "most of them", switching library means touching every consumer, every publisher and every test that sends a message.

It does not have to be that way. With ports and adapters, the domains only see a few small interfaces they own, and the bus library lives in one adapter project. Replacing the library means rewriting that adapter.

In this article, we see how a domain publishes and consumes integration events without referencing [Wolverine](https://wolverinefx.net/), how the Wolverine adapter plugs into those ports (outbox, RabbitMQ, retries), and how an architecture test keeps the library from leaking out again.


## Where the bus usually leaks
The code base this comes from already had ports for publishing and handling events, yet its design notes count **five projects** where MassTransit had leaked: the messaging configurator exposed MassTransit's `IBusRegistrationConfigurator`, the real-time adapter referenced the package, both `DbContext`s mapped its outbox tables, the service defaults registered its telemetry, and the API's integration tests used its test harness.

None of these is a domain: they are where "just use the library's type" slips in. The switch had two goals: keep the domains untouched, and close the five leaks so that the next switch really is one project.


## The ports a domain sees
The port is `Blouppy.Infrastructure.Messaging.Abstractions`, and this is everything a domain needs from it:

```csharp
public interface IMessage;

public interface IIntegrationEvent : IMessage;

public interface IIntegrationEventPublisher<in TIntegrationEvent>
    where TIntegrationEvent : class, IIntegrationEvent
{
    Task PublishAsync(TIntegrationEvent @event, CancellationToken cancellationToken = default);
}

public interface IIntegrationEventHandler<in TIntegrationEvent>
    where TIntegrationEvent : IIntegrationEvent
{
    Task HandleAsync(TIntegrationEvent @event, CancellationToken cancellationToken = default);
}

// The message ID stays the same across redeliveries, so handlers derive idempotent keys from it.
public interface IIntegrationEventContext
{
    Guid? MessageId { get; }
}
```

The project references `Microsoft.Extensions.DependencyInjection.Abstractions`, the shared kernel and one models project: no bus library, by construction. The integration events live there too, as plain records such as `WorkspaceCreatedIntegrationEvent(OrganizationId, WorkspaceId, UserId OwnerId) : IIntegrationEvent`, so there is nothing to rewrite.

On the publishing side, Workspaces turns its domain event into that integration event in `PublishIntegrationEventWhenWorkspaceCreatedDomainEventHandler`, through `IIntegrationEventPublisher<WorkspaceCreatedIntegrationEvent>` ([Domain events vs integration events](https://www.blouppy.com/blog/2026-05-28-domain-events-vs-integration-events-and-the-outbox/) shows it). That class did not change when MassTransit was replaced: it does not know whether the event goes to RabbitMQ, to an in-process queue in the tests or through an outbox.

On the consuming side, the Webhooks module's `DispatchWebhooksWhenWorkspaceCreatedIntegrationEventHandler` implements `IIntegrationEventHandler<WorkspaceCreatedIntegrationEvent>`: no `IConsumer<T>`, no `ConsumeContext`, just the event and a cancellation token. Handlers are registered by scanning the domain's own assembly with `AddIntegrationEventHandlers(assembly)`, which also lives in the port.

> **_Note:_** Several domains can handle the same event. The adapter runs **every** registered `IIntegrationEventHandler<T>` in sequence and aggregates the failures, so one failing handler does not stop the others. The message is then retried as a whole, which is why every handler must be idempotent.


## The adapter's own door
Not everything that touches the bus is a domain. A module like Billing, or another adapter like the real-time fan-out, declares consumers and publishers, and that is where `IBusRegistrationConfigurator` had leaked. The fix is a second, smaller vocabulary in the adapter project, which names nothing of the library (abridged):

```csharp
public interface IMessageConsumer<in TMessage>
    where TMessage : class
{
    Task ConsumeAsync(TMessage message, ConsumedMessage delivery, CancellationToken cancellationToken);
}

public sealed record ConsumedMessage(Guid MessageId);

public interface IMessagingConfigurator
{
    IMessagingConfigurator AddConsumer<TConsumer>() where TConsumer : class;

    IMessagingConfigurator AddInstanceScopedConsumer<TConsumer>() where TConsumer : class;

    IMessagingConfigurator AddPublisher<TIntegrationEvent>()
        where TIntegrationEvent : class, IIntegrationEvent;

    // ... overloads with a concurrency limit or a mapper to a wire DTO
}
```

- `AddConsumer<T>()` gives the consumer a queue that the replicas of a host share: each message reaches one of them. Right for work.
- `AddInstanceScopedConsumer<T>()` gives it a queue named after the process, deleted when the process stops. Right for a broadcast: the real-time adapter registers `ServerEventBroadcastConsumer` this way, because every replica holds different SSE connections and must receive every frame.

An `IMessagePublisher` completes the set. The real-time project now references the adapter, but not Wolverine: one leak closed.


## The adapter: Wolverine behind the ports
Only `Blouppy.Infrastructure.Messaging` references `WolverineFx`, `WolverineFx.RabbitMQ`, `WolverineFx.Postgresql` and `WolverineFx.EntityFrameworkCore`.

### Registration and the outbox
The API registers the bus in its composition root, with the `DbContext` that holds the outbox: `AddBlouppyMessaging<BlouppyDbContext>(configuration, messaging => messaging.AddRealTimeConsumers().ConfigureBillingMessaging())`. Inside, the adapter wires Wolverine and the outbox (abridged):

```csharp
services.AddWolverine(ExtensionDiscovery.ManualOnly, wolverine => BusTopology.Configure(
    wolverine,
    options,
    configurator.Consumers));

services
    .AddScoped<OutboxSession<TDbContext>>()
    .AddScoped<OutboxInterceptor<TDbContext>>()
    .AddScoped<IMessagePublisher, MessagePublisher<TDbContext>>();

services.ConfigureDbContext<TDbContext>((serviceProvider, dbContextOptions) =>
{
    dbContextOptions
        .ReplaceService<IModelCustomizer, OutboxModelCustomizer>()
        .AddInterceptors(serviceProvider.GetRequiredService<OutboxInterceptor<TDbContext>>());
});
```

- **The outbox is wired into the context's registration, not the context.** [`ConfigureDbContext<TDbContext>`](https://learn.microsoft.com/ef/core/dbcontext-configuration/) adds a model customizer that maps Wolverine's envelope tables (excluded from EF Core's migrations) and an interceptor that watches the commit. `BlouppyDbContext` lost its MassTransit tables and gained nothing: two more leaks closed.
- **A publish outside a consumer is a row.** The next `SaveChanges` writes it beside the domain's rows. It is sent once that transaction commits, dropped if it rolls back, and never sent if nothing saves, so a subscriber only hears of a workspace once it exists.
- **A publish inside a consumer** leaves once the consumer returns, and is dropped with the attempt when it throws.

If the send fails after the commit, the adapter logs it and leaves the persisted row to Wolverine's [durability agent](https://wolverinefx.net/guide/durability/postgresql). It never throws back into the unit of work, whose execution strategy would replay a commit that already succeeded.

### Topology, retries and dead letters
`BusTopology` turns the declared consumers into Wolverine's configuration (abridged):

```csharp
// Handlers are registered below, each as it is, so there is nothing to scan for and no code to generate.
wolverine.Discovery.DisableConventionalDiscovery();
wolverine.CodeGeneration.TypeLoadMode = TypeLoadMode.Static;

wolverine.PersistMessagesWithPostgresqlUsingNamedConnection(options.DatabaseConnectionName, options.StorageSchema);

foreach (var consumer in consumers)
{
    wolverine.AddMessageHandler(consumer.MessageType, consumer.CreateHandler());
}

wolverine
    .OnAnyException()
    .RetryWithCooldown([.. options.RetryIntervals()])
    .Then.MoveToErrorQueue();

wolverine
    .UseRabbitMqUsingNamedConnection(options.RabbitMqConnectionName)
    .AutoProvision()
    .CustomizeDeadLetterQueueing(new DeadLetterQueue($"{options.EndpointPrefix}.dead-letters"))
    .UseConventionalRouting(routing =>
    {
        routing.ExchangeNameForSending(ExchangeName);
        routing.ConfigureSending((sending, _) => sending.UseDurableOutbox());
    });
```

- **No code generation.** Wolverine normally [generates](https://wolverinefx.net/guide/codegen) an adapter per handler and compiles it with Roslyn, which requires public types. Every consumer here is `internal`, so [conventional discovery](https://wolverinefx.net/guide/handlers/discovery) is off, `TypeLoadMode.Static` is set, and each consumer is registered explicitly as a pre-built handler.
- **The same retry policy as before.** `RetryIntervals()` computes an exponential back-off (1 s, 6 s, 16 s, 36 s, then capped at 1 min), and a message that still fails goes to the host's dead-letter queue, `blouppy.dead-letters` ([error handling](https://wolverinefx.net/guide/handlers/error-handling)).
- **A fanout exchange per message type**, named after its full type name. Each consumer gets a durable queue bound to it, named after the host and the consumer, like `blouppy.workspace-created` ([RabbitMQ transport](https://wolverinefx.net/guide/messaging/transports/rabbitmq/)).

The pre-built handler is where Wolverine meets `IMessageConsumer<T>` (abridged):

```csharp
internal sealed class ConsumerMessageHandler<TMessage, TConsumer> : MessageHandler<TMessage>
    where TMessage : class
    where TConsumer : class, IMessageConsumer<TMessage>
{
    protected override async Task HandleAsync(TMessage message, MessageContext context, CancellationToken cancellation)
    {
        await using var scope = context.Runtime.Services.CreateAsyncScope();
        var services = scope.ServiceProvider;

        services.GetRequiredService<ScopedMessageContextHolder>().Context = context;

        await services
            .GetRequiredService<TConsumer>()
            .ConsumeAsync(message, new ConsumedMessage(context.Envelope!.Id), cancellation);
    }
}
```

Each delivery gets its own scope, primed with Wolverine's `MessageContext` before anything is resolved, so whatever the consumer publishes joins that delivery. `Envelope.Id` becomes the `MessageId` that domain handlers key on: the domain sees a `Guid`, and only this class sees the envelope.

> **_Note:_** Wolverine routes a message type to one handler, whereas MassTransit gave each consumer a queue. To keep the queue-per-consumer model, the adapter allows one consumer per message type and host, and refuses a second one at startup.


## A test that keeps the library inside
A boundary that only lives in a README does not survive the next deadline, so the rule is a test (abridged):

```csharp
private static readonly string[] BusLibraryPrefixes = ["Wolverine", "JasperFx", "Weasel", "MassTransit"];

[Fact]
public void Only_the_messaging_adapter_should_reference_the_bus_library()
{
    // Act
    var referencing = HostComposition.HostsAssemblies
        .Where(ReferencesTheBusLibrary)
        .Select(HostComposition.NameOf)
        .ToArray();

    // Assert — the adapter itself is expected, which is also what proves the scan sees anything.
    referencing
        .Should()
        .BeEquivalentTo(
            [AdapterName],
            "a project that names the bus library would have to be rewritten with the adapter the next time it changes");
}
```

`HostComposition.HostsAssemblies` is every Blouppy assembly the hosts compose, so a new project is checked without being listed. The prefixes include MassTransit, so the old library cannot come back. The expected result is **exactly** the adapter, not "empty": if the scan stopped seeing assemblies, an empty list would pass silently.


## What it costs
The ports duplicate concepts the library already has, and each new event needs a consumer class and a line in `AddBlouppyMessaging`: with discovery off, an unregistered consumer simply never runs. In exchange, the switch kept the same events and guarantees (outbox, back-off, dead letters, stable message IDs, fan-out to every replica), and the domains' handlers did not change.


## Conclusion
Switching message bus is painful when the library's types are everywhere. With ports and adapters, a domain publishes through `IIntegrationEventPublisher<T>` and reacts through `IIntegrationEventHandler<T>`, a module or adapter declares itself through `IMessagingConfigurator`, and Wolverine appears in one project. The hard part is not the domains but the leaks around them; closing them and locking the result with an architecture test makes the next switch one adapter to rewrite.

Messaging in [Blouppy Starter](https://starter.blouppy.com/) is built this way: Wolverine over RabbitMQ behind the messaging adapter, with the outbox in each host's own database.


## References

- [Wolverine documentation](https://wolverinefx.net/) — the library: [handler discovery](https://wolverinefx.net/guide/handlers/discovery), [code generation](https://wolverinefx.net/guide/codegen) and [error handling](https://wolverinefx.net/guide/handlers/error-handling).
- [Wolverine RabbitMQ transport](https://wolverinefx.net/guide/messaging/transports/rabbitmq/) and [conventional routing](https://wolverinefx.net/guide/messaging/transports/rabbitmq/conventional-routing) — exchanges, queues and dead letters.
- [Wolverine PostgreSQL durability](https://wolverinefx.net/guide/durability/postgresql) and [EF Core integration](https://wolverinefx.net/guide/durability/efcore/) — the transactional outbox.
- [DbContext lifetime, configuration and initialization](https://learn.microsoft.com/ef/core/dbcontext-configuration/) — EF Core documentation: configuring a context from its registration.
- [AMQP 0-9-1 model explained](https://www.rabbitmq.com/tutorials/amqp-concepts) — RabbitMQ: exchanges, queues and bindings.
- [MassTransit documentation](https://masstransit.massient.com/) — the library being replaced, and its v9 commercial release.
- [Wolverine for messaging](https://docs.starter.blouppy.com/choices/wolverine/) and [Messaging](https://docs.starter.blouppy.com/architecture/messaging/) — Blouppy Starter's documentation of the choice and the adapter.
