---
templateKey: 'blog-post'
title: 'Replacing MassTransit with Wolverine: keep the bus library in one project'
date: 2026-06-09T09:00:00.000Z
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

MassTransit went commercial with its v9, and its 8.x line is no longer maintained. For many .NET teams, that raises an uncomfortable question: how many projects actually know which message bus we use? If the answer is "most of them", switching library means touching every consumer, every publisher and every test that sends a message.

It does not have to be that way. With ports and adapters, the domains only see a few small interfaces they own, and the bus library lives in one adapter project. Replacing the library is then rewriting that adapter.

In this article, we will see how a domain publishes and consumes integration events without referencing Wolverine, how the Wolverine adapter plugs into those ports (outbox, RabbitMQ, retries), and how an architecture test keeps the library from leaking out again.


## Where the bus usually leaks
Before looking at the code, let's be honest about the starting point. The code base this comes from already had ports for publishing and handling events, yet the design notes count **five projects** where MassTransit had leaked:
- the messaging configurator exposed MassTransit's `IBusRegistrationConfigurator`,
- the real-time adapter referenced the package,
- both `DbContext`s mapped MassTransit's outbox tables,
- the service defaults registered its telemetry,
- the API's integration tests used its test harness.

None of these is a domain. They are the places where "just use the library's type, it's simpler" slips in. So the goal of the switch was twofold: keep the domains untouched, and close those five leaks so that the next switch really is one project.


## The ports a domain sees
Let's start from the inside. The port is `Blouppy.Infrastructure.Messaging.Abstractions`, and here is everything a domain needs from it:

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

// The message id stays the same across redeliveries, so handlers derive idempotent keys from it.
public interface IIntegrationEventContext
{
    Guid? MessageId { get; }
}
```

Here is what each piece does:
- `IIntegrationEventPublisher<T>` puts a fact on the bus; a domain asks for exactly the event it publishes.
- `IIntegrationEventHandler<T>` reacts to a fact.
- `IIntegrationEventContext` gives the handler a message id that is stable across retries, to stay idempotent.

The project itself references `Microsoft.Extensions.DependencyInjection.Abstractions`, the shared kernel and one models project. No bus library, by construction.

The integration events live in the same project, one folder per publishing domain. Here is one:

```csharp
public sealed record WorkspaceCreatedIntegrationEvent(
    OrganizationId OrganizationId,
    WorkspaceId WorkspaceId,
    UserId OwnerId) : IIntegrationEvent;
```

A plain record: nothing to rewrite.


## A domain that publishes
Let's look at the Workspaces domain. When a workspace is created, a domain event handler turns the domain event into an integration event:

```csharp
internal sealed class PublishIntegrationEventWhenWorkspaceCreatedDomainEventHandler(
    IIntegrationEventPublisher<WorkspaceCreatedIntegrationEvent> integrationEventPublisher)
    : IDomainEventHandler<WorkspaceCreatedDomainEvent>
{
    public async Task HandleAsync(WorkspaceCreatedDomainEvent @event, CancellationToken cancellationToken)
        => await integrationEventPublisher.PublishAsync(
            new WorkspaceCreatedIntegrationEvent(
                @event.OrganizationId,
                @event.WorkspaceId,
                @event.OwnerId),
            cancellationToken);
}
```

This class did not change when MassTransit was replaced. It does not know whether the event goes to RabbitMQ, to an in-process queue in the tests, or through an outbox: that belongs to the adapter.

The domain's project file references `Blouppy.Infrastructure.Messaging.Abstractions` and nothing else about messaging: no `WolverineFx`, no `MassTransit`.


## A module that consumes
On the other side, the Webhooks module listens for that event to notify an organization's subscribers:

```csharp
internal sealed class DispatchWebhooksWhenWorkspaceCreatedIntegrationEventHandler(
    IWebhookEventDispatcher webhookEventDispatcher)
    : IIntegrationEventHandler<WorkspaceCreatedIntegrationEvent>
{
    public Task HandleAsync(
        WorkspaceCreatedIntegrationEvent @event,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(@event);

        return webhookEventDispatcher.DispatchAsync(
            @event.OrganizationId,
            WebhookEventType.WorkspaceCreated,
            new WebhookEventData.Workspace(
                Id: @event.WorkspaceId.Value,
                ActorId: @event.OwnerId.Value),
            cancellationToken);
    }
}
```

There is no `IConsumer<T>` and no `ConsumeContext` here. The handler receives the event and a cancellation token, that's all. The handlers are registered by scanning the domain's own assembly with `AddIntegrationEventHandlers(assembly)`, which also lives in the port.

> **_Note:_**  Several domains can handle the same event. The adapter runs **every** registered `IIntegrationEventHandler<T>`, in sequence, and aggregates the failures, so a failing handler does not stop the others from running. The message is then retried as a whole, which is why every handler must be idempotent.


## The adapter's own door
Not everything that touches the bus is a domain. A module like Billing, or another adapter like the real-time fan-out, has to declare consumers and publishers. That is where MassTransit's `IBusRegistrationConfigurator` had leaked.

The fix is a second, smaller vocabulary in the adapter project `Blouppy.Infrastructure.Messaging`, which names nothing of the library:

```csharp
public interface IMessageConsumer<in TMessage>
    where TMessage : class
{
    Task ConsumeAsync(TMessage message, ConsumedMessage delivery, CancellationToken cancellationToken);
}

public sealed record ConsumedMessage(Guid MessageId);

public interface IMessagePublisher
{
    Task PublishAsync<TMessage>(TMessage message, CancellationToken cancellationToken = default)
        where TMessage : class;
}

public interface IMessagingConfigurator
{
    MessagingServiceOptions Options { get; }

    IMessagingConfigurator AddConsumer<TConsumer>() where TConsumer : class;

    IMessagingConfigurator AddInstanceScopedConsumer<TConsumer>() where TConsumer : class;

    IMessagingConfigurator AddPublisher<TIntegrationEvent>()
        where TIntegrationEvent : class, IIntegrationEvent;

    // ... overloads with a concurrency limit or a mapper to a wire DTO
}
```

Here is how the real-time adapter uses it. Every replica holds different SSE connections, so every replica must receive every frame:

```csharp
extension(IMessagingConfigurator messaging)
{
    public IMessagingConfigurator AddRealTimeConsumers()
        => messaging
            .AddInstanceScopedConsumer<ServerEventBroadcastConsumer>();
}
```

- `AddConsumer<T>()` gives the consumer a queue that the replicas of a host share: each message reaches one of them. Right for work.
- `AddInstanceScopedConsumer<T>()` gives the consumer a queue named after the process, deleted when the process stops. Right for a broadcast.

The real-time project now references the adapter, but not Wolverine. That is one of the five leaks closed. 👍


## The adapter: Wolverine behind the ports
Now let's go to the only project that references `WolverineFx`, `WolverineFx.RabbitMQ`, `WolverineFx.Postgresql` and `WolverineFx.EntityFrameworkCore`.

### Registration and the outbox
The API registers the bus in its composition root, with the `DbContext` that holds the outbox:

```csharp
services
    .AddBlouppyMessaging<BlouppyDbContext>(configuration, messaging =>
    {
        messaging
            .AddRealTimeConsumers()
            .ConfigureBillingMessaging();
    });
```

Under the hood, `AddMessagingServices<TDbContext>` wires Wolverine and the outbox. Here is the part that teaches:

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

Let's look at the decisions behind these lines:
- **The outbox is wired into the context's registration, not the context.** `ConfigureDbContext<TDbContext>` adds a model customizer that maps Wolverine's envelope tables (excluded from EF's migrations) and an interceptor that watches the commit. So `BlouppyDbContext` lost its MassTransit tables and gained nothing. Two more leaks closed.
- **A publish outside a consumer is a row.** The next `SaveChanges` writes it beside the domain's own rows. It is sent once that transaction commits, dropped if it rolls back, and never sent if nothing saves. That is why the Workspaces handler above can publish without worrying: a subscriber only hears of the workspace once it exists.
- **A publish inside a consumer** leaves once the consumer has returned, and is dropped with the attempt when it throws.

> **_Note:_**  If the send fails after the commit, the adapter logs it and leaves the persisted row to Wolverine's recovery. It never throws back into the unit of work, whose execution strategy would replay a commit that already succeeded.

### Topology, retries and dead letters
`BusTopology` turns the declared consumers into Wolverine's configuration:

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

Here is what happens:
- **No code generation.** Wolverine normally generates an adapter per handler and compiles it with Roslyn, which requires public types. Every consumer here is `internal`, so conventional discovery is turned off, `TypeLoadMode.Static` is set, and each consumer is registered explicitly as a pre-built handler.
- **The same retry policy as before.** `MessagingServiceOptions.RetryIntervals()` computes an exponential back-off (1 s, 6 s, 16 s, 36 s, then capped at 1 min), and a message that still fails goes to the host's dead-letter queue, `blouppy.dead-letters`.
- **A fanout exchange per message type**, named after its full type name. Each consumer gets a durable queue bound to it, named after the host and the consumer, like `blouppy.workspace-created`.

The pre-built handler is where Wolverine meets our own `IMessageConsumer<T>`:

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

Each delivery gets a scope of its own. The scope is primed with Wolverine's `MessageContext` before anything is resolved, so whatever the consumer publishes joins that delivery. And `Envelope.Id` becomes the `MessageId` the domain handlers key on. The domain sees a `Guid`; only this class sees the envelope.

> **_Note:_**  Wolverine handles a message type, while MassTransit gave each consumer a queue. To keep the queue-per-consumer model, the adapter allows one consumer per message type and host, and refuses a second one at startup.


## A test that keeps the library inside
A boundary that only lives in a README does not survive the next deadline. 😉 So the rule is a test in `Blouppy.Architecture.UnitTests`:

```csharp
public sealed class BusLibraryBoundaryTests
{
    private static readonly string[] BusLibraryPrefixes = ["Wolverine", "JasperFx", "Weasel", "MassTransit"];

    private static readonly string AdapterName = HostComposition.NameOf(typeof(Blouppy.Infrastructure.Messaging.IMessagePublisher).Assembly);

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

    private static bool ReferencesTheBusLibrary(Assembly assembly)
        => assembly
            .GetReferencedAssemblies()
            .Any(reference => BusLibraryPrefixes.Any(prefix => reference.Name!.StartsWith(prefix, StringComparison.Ordinal)));
}
```

Let's look at the details:
- `HostComposition.HostsAssemblies` is every Blouppy assembly composed by the API and the identity host, so a new project is checked without being listed.
- The prefixes cover Wolverine and its JasperFx and Weasel dependencies, and MassTransit, so the old library cannot come back through a forgotten package.
- The expected result is **exactly** the adapter, not "empty". If the scan ever stopped seeing assemblies, an empty list would pass silently; expecting the adapter proves the test looks at something.


## What it costs
This design is not free. The ports duplicate concepts the library already has, and each new event needs a consumer class and a line in `AddBlouppyMessaging`: with discovery off, a consumer that is not registered simply never runs. In exchange, the switch kept the same events and the same guarantees (outbox, back-off, dead letters, stable message ids, fan-out to every replica), and the domains' handlers did not change.


## Conclusion
Switching message bus is painful when the library's types are everywhere. With ports and adapters, a domain publishes through `IIntegrationEventPublisher<T>` and reacts through `IIntegrationEventHandler<T>`, a module or another adapter declares itself through `IMessagingConfigurator`, and Wolverine only appears in one project: its outbox on EF Core and PostgreSQL, its RabbitMQ topology, its retries and its pre-built handlers.

As we have seen, the hard part is not the domains, it is the leaks around them: a configurator that exposes the library, a `DbContext` that maps its tables, a test harness. Closing them, and then locking the result with an architecture test, is what makes the next switch a single adapter to rewrite.

This is how messaging is built in [Blouppy Starter](https://starter.blouppy.com/): Wolverine over RabbitMQ behind the messaging adapter, with the outbox in each host's own database. The [messaging documentation](https://docs.starter.blouppy.com/architecture/messaging/) explains each of these choices.

*Thanks for reading! 🙂*
