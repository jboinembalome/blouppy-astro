---
templateKey: 'blog-post'
title: 'Server-sent events with ASP.NET Core and Angular: a frame is a signal, never the data'
date: 2026-09-13T09:00:00.000Z
author: Jimmy Boinembalome
authorimage: /img/jimmy.jpg
category: C#
categorycolor: bg-purple-100 text-purple-800
featuredpost: true
featuredimage: /img/server-sent-events-with-aspnet-core-and-angular.jpg
description: >-
  Learn how to push real-time updates from ASP.NET Core to Angular with server-sent events, across several replicas, without a dropped frame ever showing a wrong screen.
tags:
  - Development
  - C#
  - ASP.NET Core
  - Angular
  - Server-Sent Events
  - RabbitMQ
---

A notification bell that updates on its own looks like a small feature. Then the questions arrive: do we need SignalR? What happens when the API runs on three replicas and the browser is connected to only one? And what does the screen show when a frame is lost during a reconnect?

Most real-time bugs come from the same decision: pushing the data itself. Once the frame carries the new notification, a lost frame means a missing notification, and two frames in the wrong order mean a wrong screen.

In this article, we will build a single server-sent events (SSE) stream with ASP.NET Core and Angular, around one rule: **a frame is a signal, never the data**. We will see the endpoint, the per-process registry of connections, the fan-out across replicas over RabbitMQ, and the Angular service that shares one `EventSource` per tab.


## Why server-sent events, and why one stream
Server-sent events are plain HTTP: a `GET` whose response never ends, with a `text/event-stream` body made of small text frames. The browser's `EventSource` opens it, parses it and **reconnects on its own**. No extra client library, and it goes through a reverse proxy like any other request. It cannot talk back, which is fine: the client already has the normal API for that.

The code base this comes from exposes exactly one stream:

```text:clipboard=false
GET /api/v1/events/stream?topic=kind:value
```

One endpoint for every kind of push, not one per feature. Over HTTP/1.1 a browser allows six connections per origin, and a stream per feature spends that budget on plumbing. What a client follows is named by a **topic**.


## A topic is opaque to the transport
Let's look at the topic type, in `Blouppy.Infrastructure.RealTime.Abstractions`:

```csharp
public sealed record ServerEventTopic
{
    public const string UserKind = "user";

    private const char Separator = ':';

    public ServerEventTopic(string kind, string value)
    {
        Kind = Exceptions.ThrowIfNullOrWhiteSpace(kind);
        Value = Exceptions.ThrowIfNullOrWhiteSpace(value);
    }

    public string Kind { get; }

    public string Value { get; }

    public static ServerEventTopic ForUser(UserId userId)
        => new(UserKind, userId.Value);

    public override string ToString()
        => $"{Kind}{Separator}{Value}";
}
```

- `Kind` is the family (`user` today, `workspace` tomorrow) and `Value` the identifier inside it, kept as a string: the transport never parses it.
- `ToString()` gives the wire form, `kind:value`: what the client sends in the query string and the key of the registry. A `TryParse` method (not shown) reads it back, splitting on the first colon only.

So the registry, the fan-out and the endpoint never learn a new word when a new kind of push appears.

Publishing goes through a port:

```csharp
public interface IServerEventPublisher
{
    Task PublishAsync(ServerEventTopic topic, ServerEvent @event, CancellationToken cancellationToken = default);
}
```

`ServerEvent` is a name (the SSE `event:` field) and a payload **already serialised** to JSON. It is a string rather than an object because the frame crosses RabbitMQ on its way to the right replica, and a message contract carrying `object` is a deserialisation problem waiting to happen.

Here is the one producer, the notification dispatcher, once the notifications are stored:

```csharp
await unitOfWork.CommitAsync(
    async () =>
    {
        foreach (var notification in notifications)
        {
            await serverEventPublisher.PublishAsync(
                ServerEventTopic.ForUser(notification.RecipientId),
                ServerEvent.From(ServerEventName, new { type = request.Type.ToString() }),
                cancellationToken);
        }
    },
    cancellationToken);
```

The payload is `{ "type": "..." }` under the event name `notifications.changed`. No title, no body, no id: just "your list has changed". And because the publish runs inside the commit, it goes through the transactional outbox, so a frame announcing a row is never on the wire before that row is committed.


## Who may follow a topic
A stream is a read, so it needs authorization. Instead of a `switch` in the endpoint, there is one `IServerEventTopicAuthorizer` per kind, with a `Kind` and an `IsAllowedAsync`:

```csharp
internal sealed class UserServerEventTopicAuthorizer : IServerEventTopicAuthorizer
{
    public string Kind => ServerEventTopic.UserKind;

    public Task<bool> IsAllowedAsync(UserId userId, ServerEventTopic topic, CancellationToken cancellationToken = default)
        => Task.FromResult(string.Equals(topic.Value, userId.Value, StringComparison.Ordinal));
}
```

A user may follow their own stream and nobody else's. The controller resolves the authorizers as a set, `IEnumerable<IServerEventTopicAuthorizer>`, and picks the one for each requested kind:

```csharp
// No authorizer for a kind means nobody has decided who may read it, which is a
// refusal rather than an omission to wave through.
var authorizer = topicAuthorizers.FirstOrDefault(x => string.Equals(x.Kind, topic.Kind, StringComparison.Ordinal));

if (authorizer is null || !await authorizer.IsAllowedAsync(userId, topic, cancellationToken))
{
    return Forbid();
}
```

This **fails closed**: a new kind of topic without its authorizer is answered 403. Adding a kind of push is a new authorizer, not a new route, and not a second connection.

## Writing the stream by hand
.NET 10 added `TypedResults.ServerSentEvents` for minimal APIs. The code base does not use it: the controller action returns its own `IActionResult`, `ServerEventStreamResult`, and a small `ServerSentEventWriter` writes the format by hand. Returning a result, rather than looping inside the action, lets authorization still answer 400 or 403: once the first byte is written, the response is committed.

Let's see how the response is prepared:

```csharp
public static void Prepare(HttpResponse response)
{
    response.ContentType = "text/event-stream";
    response.Headers.CacheControl = "no-cache, no-transform";
    // Nothing to negotiate on a stream, and a proxy that compresses it also buffers it.
    response.Headers.ContentEncoding = "identity";
    // Read by nginx and friends, ignored by everyone else: do not buffer this one.
    response.Headers["X-Accel-Buffering"] = "no";

    response.HttpContext.Features.Get<IHttpResponseBodyFeature>()?.DisableBuffering();
}
```

Every header here keeps a proxy from caching, compressing or buffering the stream, and `DisableBuffering()` does the same on ASP.NET Core's side; every write is then followed by a `FlushAsync`. Without that, frames arrive in batches whenever a buffer happens to fill.

Then three kinds of frames:

```csharp
public static async Task WriteEventAsync(HttpResponse response, ServerEvent @event, CancellationToken cancellationToken = default)
{
    var frame = new StringBuilder()
        .Append("event: ").Append(@event.Name).Append('\n');

    foreach (var line in @event.Data.Split('\n'))
    {
        frame.Append("data: ").Append(line.TrimEnd('\r')).Append('\n');
    }

    frame.Append('\n');

    await WriteAsync(response, frame.ToString(), cancellationToken);
}

public static Task WriteHeartbeatAsync(HttpResponse response, CancellationToken cancellationToken = default)
    => WriteAsync(
        response,
        string.Create(CultureInfo.InvariantCulture, $": heartbeat {DateTimeOffset.UtcNow:O}\n\n"),
        cancellationToken);
```

- A payload containing a newline is sent as several `data:` lines, or the frame would end early.
- The heartbeat is an SSE **comment** (a line starting with `:`): the browser ignores it, but a proxy sees bytes on a quiet connection. One goes out every 20 seconds, under the 60 seconds a proxy usually gives an idle connection.
- `WriteRetryAsync` (not shown) sends `retry: 5000` once at the start: `EventSource` reconnects by itself, and that field is the only say the server has in it.

The loop itself races the next frame against the heartbeat delay instead of running a timer beside it, because two tasks writing to one response body would interleave their bytes:

```csharp
var completed = await Task.WhenAny(next, Task.Delay(heartbeatInterval, heartbeat.Token));

if (completed != next)
{
    await ServerSentEventWriter.WriteHeartbeatAsync(response, cancellationToken);

    continue;
}
```

The token is `HttpContext.RequestAborted`, so a closed tab ends the loop, and the `using` on the subscription removes the connection from the registry.


## The registry: one bounded channel per connection
The connections live in `ServerEventHub`, a singleton (a scoped one would lose every connection the moment the request that opened it ended). It keeps a `ConcurrentDictionary` from topic to connections, and gives each connection a `Channel<ServerEvent>`:

```csharp
var channel = Channel.CreateBounded<ServerEvent>(new BoundedChannelOptions(ConnectionCapacity)
{
    FullMode = BoundedChannelFullMode.DropOldest,
    SingleReader = true,
    SingleWriter = false
});
```

`ConnectionCapacity` is 64. A client too slow to keep up **loses its oldest frames** instead of growing a queue without bound. In most designs, dropping frames would be a bug. Here it is the right trade, because every frame is an invalidation the client recovers from by re-reading.

The registry is deliberately in memory: a stream is worth exactly as long as the socket carrying it, so there is nothing to persist.


## Several replicas: a queue per instance
The in-memory registry has one cost: `Deliver` only reaches the connections of the process it runs on. With three replicas behind a load balancer, the browser is connected to one of them, and the request that created the notification probably ran on another.

So `ServerEventPublisher` never calls the hub. It publishes a message on the bus:

```csharp
await publisher.PublishAsync(
    new ServerEventBroadcastDto(topic.ToString(), @event.Name, @event.Data),
    cancellationToken);
```

And every replica consumes it:

```csharp
public IMessagingConfigurator AddRealTimeConsumers()
    => messaging
        .AddInstanceScopedConsumer<ServerEventBroadcastConsumer>();
```

A normal consumer shares one queue, so each message goes to exactly one replica: right for work, wrong for a broadcast. `AddInstanceScopedConsumer` gives the consumer a queue named after the process instance, deleted once the process stops consuming it, so **every replica receives its own copy**. A replica with no connection on that topic simply does nothing with it.

```csharp
public Task ConsumeAsync(ServerEventBroadcastDto message, ConsumedMessage delivery, CancellationToken cancellationToken)
{
    if (!ServerEventTopic.TryParse(message.Topic, out var topic) || topic is null)
    {
        logger.LogWarning("Discarding a server event broadcast with an unreadable topic {Topic}", message.Topic);

        return Task.CompletedTask;
    }

    hub.Deliver(topic, new ServerEvent(message.EventName, message.Data));

    return Task.CompletedTask;
}
```

Nothing here throws: failing the message would only make the broker redeliver it to a process that still has no such connection, and the client recovers on its next read anyway. The bus itself (Wolverine over RabbitMQ) has [its own article](https://www.blouppy.com/blog/2026-06-09-replacing-masstransit-with-wolverine/).


## Through the gateway
Here the browser never calls the API directly: a YARP gateway holds the session cookie and attaches the access token ([the BFF article](https://www.blouppy.com/blog/2026-05-10-keep-the-access-token-out-of-the-browser-bff-angular-yarp/) covers it). Every call through it must carry an `X-CSRF: 1` header, added by an Angular interceptor. But `EventSource` cannot set headers, so the stream would be answered 401.

The gateway maps it on its own, ahead of the catch-all:

```csharp
app.MapRemoteApi("/api/v1/events", blouppyConfiguration.BackendUrl, requireAntiforgeryHeader: false);

app.MapRemoteApi("/api", blouppyConfiguration.BackendUrl);
```

The exemption is safe for three reasons stated next to it: it is a read-only `GET`, a frame is only a signal, and the session cookie is `SameSite=Strict`, so a cross-site page cannot make the browser send it.


## In Angular: one EventSource per tab
On the client, `ServerEventsService` (in `core/real-time/`) owns the single `EventSource`. A caller names an event and gets a callback, plus the function that stops it:

```typescript
public listen(name: string, listener: Listener): () => void {
  const listeners = this._listeners.get(name) ?? new Set<Listener>();
  listeners.add(listener);
  this._listeners.set(name, listeners);

  // (trimmed: binds a new event name on a stream that is already open)
  this.open();

  return () => {
    listeners.delete(listener);

    if (listeners.size === 0) {
      this._listeners.delete(name);
    }

    if (this._listeners.size === 0) {
      this.close();
    }
  };
}
```

- The stream **opens on the first listener and closes after the last**, so a signed-out or prerendered page never opens one.
- `follow(topic)` adds a topic and reopens the stream, since the topics are part of the URL.

> **_Note:_**  With no `topic` in the query string, the API follows the caller's own user topic, so the client does not even need to know its own id. 😉

The connection is created with `new EventSource(this.buildUrl(), { withCredentials: true })`, and `onerror` only sets the status to `'reconnecting'`: the browser retries on the delay the server sent.

One more behaviour only the rule makes possible: on `visibilitychange`, a hidden tab closes its connection and reopens it when the user comes back. Every frame sent in between is lost, and that is fine.

The consumer, `NotificationService`, simply re-reads:

```typescript
this._stopListening = this._serverEvents.listen(NOTIFICATIONS_CHANGED, () => this.refresh());
```

`refresh()` calls the same two endpoints as on a page load, the five most recent notifications and the unread count, and writes them into signals the bell reads. A frame that never arrives costs a stale badge until the next read, never a wrong one.


## Conclusion
Server-sent events give us real-time updates over plain HTTP: one `GET` per tab, headers that stop buffering, a heartbeat for the proxies and a `retry:` field for the browser. A `kind:value` topic, with one authorizer per kind that fails closed, keeps the endpoint generic.

Across replicas, an in-memory registry is enough once every replica receives every frame, which a queue per instance does, and a bounded channel per connection drops frames rather than memory. These shortcuts are safe for one reason: the frame says "something changed", and the client re-reads through the same endpoints as on a page load.

This is how real-time updates are built in [Blouppy Starter](https://starter.blouppy.com/), from the notification dispatcher to the bell in the Angular shell. The [real-time page of its documentation](https://docs.starter.blouppy.com/architecture/real-time/) summarizes the design.

*Thanks for reading! 🙂*
