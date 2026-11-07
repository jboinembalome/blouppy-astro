---
templateKey: 'blog-post'
title: 'Server-sent events with ASP.NET Core and Angular: a frame is a signal, never the data'
date: 2026-09-13T09:00:00.000Z
updated: 2026-11-07T09:00:00.000Z
author: Jimmy Boinembalome
authorimage: /img/jimmy.jpg
category: C#
topic: 'Messaging'
illustration: 1
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

Most real-time bugs come from one decision: pushing the data itself. If the frame carries the new notification, a lost frame is a missing notification, and two frames in the wrong order are a wrong screen.

In this article, we will build a single [server-sent events](https://html.spec.whatwg.org/multipage/server-sent-events.html) (SSE) stream with ASP.NET Core and Angular around one rule: **a frame is a signal, never the data**. We will cover the endpoint, the per-process registry of connections, the fan-out across replicas over RabbitMQ, and the Angular client.


## Why server-sent events, and why one stream
Server-sent events are plain HTTP: a `GET` whose `text/event-stream` response never ends. The browser's [`EventSource`](https://developer.mozilla.org/docs/Web/API/EventSource) opens it, parses it and **reconnects on its own**, with no client library. It is one-way, which is fine: the client has the regular API to talk back. The code base exposes exactly one stream:

```text:clipboard=false
GET /api/v1/events/stream?topic=kind:value
```

Over HTTP/1.1, a browser allows six connections per origin, so a stream per feature would spend that budget on plumbing. What a client follows is named by a **topic**.


## A topic is opaque to the transport
The topic type lives in `Blouppy.Infrastructure.RealTime.Abstractions`:

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

    public override string ToString()
        => $"{Kind}{Separator}{Value}";
}
```

`Kind` is the family (`user` today, `workspace` tomorrow) and `Value` the identifier inside it, kept as a string. `ToString()` gives the wire form that the client sends and that keys the registry; `TryParse` and `ForUser(UserId)` are not shown. A new kind of push teaches the transport nothing new.

Publishing goes through a port, `IServerEventPublisher.PublishAsync(topic, @event, cancellationToken)`. A `ServerEvent` is a name (the SSE `event:` field) and a payload **already serialized** to JSON, because the frame crosses RabbitMQ and a message contract that carries `object` is hard to deserialize safely.

The only producer is the notification dispatcher, once the notifications are stored:

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

The event is `notifications.changed` with a payload of `{ "type": "..." }`: no title, no body, no id. The publish runs inside the commit, through the transactional outbox, so a frame never announces a row that is not committed yet.


## Who may follow a topic
Instead of a `switch` in the endpoint, there is one `IServerEventTopicAuthorizer` per kind, with a `Kind` and an `IsAllowedAsync(userId, topic, cancellationToken)`. The `user` one lets a user follow their own topic and nobody else's. The controller receives them all as an `IEnumerable<IServerEventTopicAuthorizer>`:

```csharp
// No authorizer for a kind means nobody has decided who may read it, which is a
// refusal rather than an omission to wave through.
var authorizer = topicAuthorizers.FirstOrDefault(x => string.Equals(x.Kind, topic.Kind, StringComparison.Ordinal));

if (authorizer is null || !await authorizer.IsAllowedAsync(userId, topic, cancellationToken))
{
    return Forbid();
}
```

This **fails closed**: a new kind of topic without an authorizer gets a 403.


## Writing the stream
.NET 10 added [`TypedResults.ServerSentEvents`](https://learn.microsoft.com/aspnet/core/fundamentals/minimal-apis/responses#server-sent-events-sse) for minimal APIs. The code base uses a controller, so the action returns its own `IActionResult`, `ServerEventStreamResult`, and a small `ServerSentEventWriter` writes the format. Returning a result rather than looping inside the action keeps 400 and 403 possible: once the first byte is written, the response is committed. `Prepare` sets the headers:

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

They stop a proxy from caching, compressing or [buffering](https://nginx.org/en/docs/http/ngx_http_proxy_module.html#proxy_buffering) the stream, [`DisableBuffering()`](https://learn.microsoft.com/dotnet/api/microsoft.aspnetcore.http.features.ihttpresponsebodyfeature.disablebuffering) does the same in ASP.NET Core, and every write is followed by a `FlushAsync`. Without them, frames arrive in batches whenever a buffer fills.

An event frame is written like this (`WriteAsync` writes and flushes):

```csharp
public static async Task WriteEventAsync(
    HttpResponse response,
    ServerEvent @event,
    CancellationToken cancellationToken = default)
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
```

- A payload that contains a newline is sent as several `data:` lines; otherwise, the frame would end early.
- `WriteHeartbeatAsync` writes an SSE **comment**, `: heartbeat <timestamp>`. The browser ignores it, but a proxy sees bytes on a quiet connection. The [spec's authoring notes](https://html.spec.whatwg.org/multipage/server-sent-events.html#authoring-notes) recommend one about every 15 seconds; the code base sends one every 20 seconds, under the 60 seconds a proxy usually gives an idle connection.
- `WriteRetryAsync` (not shown) sends `retry: 5000` once, at the start: the only say the server has in how `EventSource` reconnects.

The loop races the next frame against the heartbeat delay instead of running a timer beside it, because two tasks writing to one response body would interleave their bytes:

```csharp
var completed = await Task.WhenAny(next, Task.Delay(heartbeatInterval, heartbeat.Token));

if (completed != next)
{
    await ServerSentEventWriter.WriteHeartbeatAsync(response, cancellationToken);

    continue;
}
```

The token is `HttpContext.RequestAborted`, so closing the tab ends the loop, and disposing the subscription removes the connection from the registry.


## The registry: one bounded channel per connection
The connections live in `ServerEventHub`, a singleton that maps each topic to its connections in a `ConcurrentDictionary` and gives each connection a [`Channel<ServerEvent>`](https://learn.microsoft.com/dotnet/core/extensions/channels):

```csharp
var channel = Channel.CreateBounded<ServerEvent>(new BoundedChannelOptions(ConnectionCapacity)
{
    FullMode = BoundedChannelFullMode.DropOldest,
    SingleReader = true,
    SingleWriter = false
});
```

`ConnectionCapacity` is 64. A client too slow to keep up **loses its oldest frames** instead of growing a queue without bound. Elsewhere that would be a bug; here every frame is an invalidation the client recovers from by re-reading.


## Several replicas: one queue per instance
The in-memory registry has a cost: `Deliver` only reaches the connections of its own process, and with three replicas the request that created the notification probably ran on another one than the browser's.

So `ServerEventPublisher` never calls the hub. It publishes a `ServerEventBroadcastDto(topic.ToString(), @event.Name, @event.Data)` on the bus, and every replica consumes it:

```csharp
public IMessagingConfigurator AddRealTimeConsumers()
    => messaging
        .AddInstanceScopedConsumer<ServerEventBroadcastConsumer>();
```

A regular consumer shares one queue, so each message reaches one replica: right for work, wrong for a broadcast. `AddInstanceScopedConsumer` gives each process its own queue, deleted when the process stops, so **every replica receives a copy** and calls `hub.Deliver`. The consumer never throws: a redelivery would reach a process that still has no such connection. The bus itself ([Wolverine over RabbitMQ](https://wolverinefx.net/guide/messaging/transports/rabbitmq/)) has [its own article](https://www.blouppy.com/blog/2026-06-09-replacing-masstransit-with-wolverine/).


## Through the gateway
A [YARP](https://learn.microsoft.com/aspnet/core/fundamentals/servers/yarp/getting-started) gateway holds the session cookie and attaches the access token (see [the BFF article](https://www.blouppy.com/blog/2026-05-10-keep-the-access-token-out-of-the-browser-bff-angular-yarp/)). It requires an `X-CSRF: 1` header on every call, but `EventSource` cannot set headers, so the stream is mapped on its own, ahead of the catch-all:

```csharp
app.MapRemoteApi("/api/v1/events", blouppyConfiguration.BackendUrl, requireAntiforgeryHeader: false);

app.MapRemoteApi("/api", blouppyConfiguration.BackendUrl);
```

The exemption is safe: the stream is a read-only `GET`, a frame is only a signal, and the session cookie is `SameSite=Strict`, so a cross-site page cannot make the browser send it.


## In Angular: one EventSource per tab
On the client, `ServerEventsService` (in `core/real-time/`) owns the single `EventSource`. `listen(name, listener)` registers a callback for one event name and returns the function that removes it:

- The stream **opens on the first listener and closes after the last**, so a signed-out or prerendered page never opens one.
- `follow(topic)` adds a topic and reopens the stream. With no `topic`, the API follows the caller's own user topic.
- It is created with `new EventSource(this.buildUrl(), { withCredentials: true })`, and `onerror` only sets the status to `'reconnecting'`: the browser retries after the delay the server sent.
- On `visibilitychange`, a hidden tab closes its connection and reopens it when the user comes back. The frames sent in between are lost, and that is fine.

The consumer, `NotificationService`, re-reads:

```typescript
this._stopListening = this._serverEvents.listen(NOTIFICATIONS_CHANGED, () => this.refresh());
```

`refresh()` calls the same two endpoints as a page load and writes the results into [signals](https://angular.dev/guide/signals) that the bell reads. A lost frame costs a stale badge until the next read, never a wrong one.


## Conclusion
Server-sent events give us real-time updates over plain HTTP: one `GET` per tab, unbuffered, with a heartbeat for proxies and a `retry:` field for the browser. A `kind:value` topic with one fail-closed authorizer per kind keeps the endpoint generic. A queue per instance lets an in-memory registry work across replicas, and a bounded channel per connection drops frames rather than memory. Those shortcuts are safe for one reason: a frame only says "something changed", and the client re-reads through the same endpoints as a page load.

This is how real-time updates work in [Blouppy Starter](https://starter.blouppy.com/), from the notification dispatcher to the bell in the Angular shell. The [real-time page of its documentation](https://docs.starter.blouppy.com/architecture/real-time/) summarizes the design.

## References
- [Server-sent events — HTML Living Standard (WHATWG)](https://html.spec.whatwg.org/multipage/server-sent-events.html) — the `text/event-stream` format, `retry:`, comments and the reconnection model.
- [Server-sent events in minimal API responses (Microsoft Learn)](https://learn.microsoft.com/aspnet/core/fundamentals/minimal-apis/responses#server-sent-events-sse) — `TypedResults.ServerSentEvents`, added in ASP.NET Core 10.
- [`IHttpResponseBodyFeature.DisableBuffering` (Microsoft Learn)](https://learn.microsoft.com/dotnet/api/microsoft.aspnetcore.http.features.ihttpresponsebodyfeature.disablebuffering) — turning off response buffering in ASP.NET Core.
- [Channels in .NET (Microsoft Learn)](https://learn.microsoft.com/dotnet/core/extensions/channels) — bounded channels and `BoundedChannelFullMode`.
- [`EventSource` (MDN)](https://developer.mozilla.org/docs/Web/API/EventSource) — the browser API, `withCredentials` and the per-origin connection limit.
- [Using server-sent events (MDN)](https://developer.mozilla.org/docs/Web/API/Server-sent_events/Using_server-sent_events) — named events and listeners on the client.
- [nginx `proxy_buffering`](https://nginx.org/en/docs/http/ngx_http_proxy_module.html#proxy_buffering) — why `X-Accel-Buffering: no` matters behind nginx.
- [Getting started with YARP (Microsoft Learn)](https://learn.microsoft.com/aspnet/core/fundamentals/servers/yarp/getting-started) — the reverse proxy the gateway is built on.
- [Wolverine RabbitMQ transport](https://wolverinefx.net/guide/messaging/transports/rabbitmq/) — the bus that carries the broadcast.
- [Signals (angular.dev)](https://angular.dev/guide/signals) — the state the bell reads.
- [Blouppy Starter documentation: real time](https://docs.starter.blouppy.com/architecture/real-time/) — the design summarized for the Starter.
