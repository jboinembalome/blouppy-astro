---
templateKey: 'blog-post'
title: 'The AddStandardResilienceHandler trap: when Aspire''s defaults retry a POST you shouldn''t'
date: 2026-11-24T09:00:00.000Z
author: Jimmy Boinembalome
authorimage: /img/jimmy.jpg
category: C#
categorycolor: bg-purple-100 text-purple-800
featuredpost: true
featuredimage: /img/the-addstandardresiliencehandler-trap.jpg
description: >-
  Learn why Aspire's ServiceDefaults add retries, a circuit breaker and service discovery to every HttpClient, and how to take them off a client that calls URLs your users chose.
tags:
  - Development
  - C#
  - ASP.NET Core
  - .NET Aspire
  - Resilience
  - Webhooks
---

Every project created from the Aspire templates gets a `ServiceDefaults` project, and every host calls `AddServiceDefaults()`. Among the useful things it turns on, there is one line that applies to **every** `HttpClient` the host will ever create: a standard resilience handler and service discovery. Including the client someone adds next year, in another project, to send webhooks to a URL a customer typed into a form.

For calls between our own services, that default is exactly right. For a `POST` to somebody else's server, it is not.

In this article, we will look at what these defaults really do, why they are wrong for an outgoing webhook client, how to remove them for that one client, and how to write a unit test that keeps them removed.


## What ServiceDefaults turns on
Here is the part of `Extensions.cs` in the `ServiceDefaults` project that matters. It is the template's code, unchanged:

```csharp
builder.Services.AddServiceDiscovery();

builder.Services.ConfigureHttpClientDefaults(http =>
{
    // Turn on resilience by default
    http.AddStandardResilienceHandler();

    // Turn on service discovery by default
    http.AddServiceDiscovery();
});
```

`ConfigureHttpClientDefaults` registers a callback that `IHttpClientFactory` runs for every named or typed client, wherever it is registered. Nothing in the client's own registration says these handlers are there.

`AddStandardResilienceHandler()` (from `Microsoft.Extensions.Http.Resilience`) wraps the client in a Polly pipeline with five strategies:
- **A rate limiter** that caps concurrent requests.
- **A total request timeout**, covering all the attempts together.
- **A retry** with exponential backoff, on 5xx, 408, 429, network errors and timeouts.
- **A circuit breaker** that stops sending requests for a while when too many fail.
- **An attempt timeout**, for each individual try.

`AddServiceDiscovery()` adds a delegating handler that rewrites a request's host when it matches a service name the configuration knows about: `https://webapi/...` becomes the real address of the `webapi` resource.

For a call from our API to our identity server, all of this is welcome: the target is ours, a breaker protects a service we operate, and the name `webapi` is one we chose. 👍


## Why it is wrong for webhooks
Now let's take a client that sends signed `POST` requests to endpoints configured by each organization, as in the code base this comes from.

### Retries that nobody records
A webhook delivery is a row in the database with its own retry budget: `WebhookRules.RetryBackoff` is 1 min, 5 min, 30 min, 2 h and 6 h, six attempts in total, and each attempt is written into the delivery's history.

With the standard handler, a subscriber answering `500` (or too slowly) gets the same `POST` again a couple of seconds later, then again, though it may already have acted on the first one. Our history records one attempt; the subscriber received several, outside the budget the row is supposed to control.

### One circuit breaker for every tenant
The resilience pipeline belongs to the client, not to the destination. So one organization with a dead endpoint makes enough requests fail to open the breaker, and from then on the deliveries of **every other organization** are rejected without being sent. A customer's broken server becomes everyone's outage.

### Timeouts we did not choose
`HttpWebhookSender` bounds each attempt itself, with a `CancellationTokenSource` cancelled after `WebhookRules.SendTimeout` (ten seconds). The delivery's claim lease (two minutes) is designed to stay longer than that, so an attempt still running is never queued a second time. The standard handler's own timeouts sit inside the pipeline and would decide instead.

### Service discovery on a user's host
This one is the most surprising. The webhook client is protected against server-side request forgery: its primary handler resolves the host itself, checks every address against private and reserved ranges, and connects to the address it has just checked. Service discovery runs **before** that, as a delegating handler. If a customer registers `https://webapi/hooks` as their endpoint, discovery rewrites it to the internal address of our own API. That is a second resolver in front of the one the security relies on.

> **_Note:_**  We could tune the standard handler instead: `Retry.DisableForUnsafeHttpMethods()` stops it retrying a `POST`, and `SelectPipelineByAuthority()` gives each host its own breaker. But the timeouts and the discovery handler would still be there. For a client that talks to someone else's server, the simplest correct pipeline is no extra handler at all.


## The fix: clear the additional handlers
Both the resilience handler and the discovery handler are registered as **additional** message handlers, and the defaults are applied before the client's own configuration. So the client's registration can simply empty the list. Here is the webhook client's registration, in `Blouppy.Infrastructure.Webhooks/ServiceCollectionExtensions.cs`:

```csharp
services
    .AddHttpClient<IWebhookSender, HttpWebhookSender>(HttpWebhookSender.HttpClientName)
    // Clears the Aspire resilience and service-discovery handlers: retries would bypass
    // the delivery's own retry budget, and discovery would resolve user hosts to our services.
    .ConfigureAdditionalHttpMessageHandlers((handlers, _) => handlers.Clear())
    .ConfigurePrimaryHttpMessageHandler(provider =>
    {
        var options = provider.GetRequiredService<IOptions<WebhookOptions>>();

        return PublicOnlyHttpHandler.Create(
            () => options.Value.AllowPrivateNetworkTargets,
            WebhookRules.ConnectTimeout);
    })
    .ConfigureHttpClient(client => client.Timeout = WebhookRules.SendTimeout * 2);
```

- `ConfigureAdditionalHttpMessageHandlers` gives us the list of delegating handlers built so far, including the ones the defaults added. `handlers.Clear()` removes them all.
- `ConfigurePrimaryHttpMessageHandler` installs the handler that resolves and checks addresses (`PublicOnlyHttpHandler`), now with nothing in front of it.
- `client.Timeout` is a safety net at twice the per-attempt budget.

The result: **one attempt is exactly one request**, and the only retry policy is the row's.

### Why not RemoveAllResilienceHandlers()?
`Microsoft.Extensions.Http.Resilience` has a `RemoveAllResilienceHandlers()` extension, which looks like the obvious choice. The design note records why it was not used: it would only take the first handler, and it is still marked experimental. And even when it does its job, its name says what it covers: resilience handlers. The service discovery handler is not one of them, and it is the one with security consequences.

> **_Note:_**  `Clear()` removes every additional handler, including any you add yourself earlier in the same registration. If the client needs one, add it **after** the `ConfigureAdditionalHttpMessageHandlers` call. 😉

The same line appears on every client in that code base that calls a URL it does not control, such as the identity server's fetch of an SSO issuer's metadata.


## Testing it
This fix could disappear in a refactoring without anything turning red, so `WebhookHttpClientPipelineTests` rebuilds what a host does and checks the result. Let's start with the setup: what `ServiceDefaults` does, the webhook client, and an ordinary client used as a control:

```csharp
var services = new ServiceCollection();

// What Blouppy.Aspire.ServiceDefaults does for every host.
services.AddServiceDiscovery();
services.ConfigureHttpClientDefaults(http =>
{
    http.AddStandardResilienceHandler();
    http.AddServiceDiscovery();
});

services.AddWebhookDelivery(configuration, environment);

services
    .AddHttpClient(HttpWebhookSender.HttpClientName)
    .ConfigurePrimaryHttpMessageHandler(() => subscriber);

services
    .AddHttpClient("any-other-client")
    .ConfigurePrimaryHttpMessageHandler(() => subscriber);
```

The `subscriber` is a `StubHttpMessageHandler`, a small `HttpMessageHandler` that answers with a given response and records every request. The first test checks what matters to subscribers:

```csharp
var subscriber = new StubHttpMessageHandler(_ => new HttpResponseMessage(HttpStatusCode.InternalServerError));

// ...

var result = await sut.SendAsync(Given_a_request(), TestContext.Current.CancellationToken);

subscriber.Requests
    .Should()
    .ContainSingle();
```

With the standard handler in place, a `500` would be retried and the stub would see several requests. Here it must see exactly one.

The second test checks the pipeline itself, by walking the chain of `DelegatingHandler`s returned by `IHttpMessageHandlerFactory`:

```csharp
var webhookHandlers = Given_the_handler_chain(factory.CreateHandler(HttpWebhookSender.HttpClientName));
var otherHandlers = Given_the_handler_chain(factory.CreateHandler("any-other-client"));

// Control: the defaults do add these handlers.
otherHandlers
    .Should()
    .Contain(name => name.Contains("Resilience"))
    .And
    .Contain(name => name.Contains("Resolving"));

webhookHandlers
    .Should()
    .NotContain(name => name.Contains("Resilience"))
    .And
    .NotContain(name => name.Contains("Resolving"));
```

The **control** is the important part. Without it, "no resilience handler" would also pass if the setup forgot `ConfigureHttpClientDefaults`, or if a package update renamed the handlers.

A third test maps `Services:webapi:https:0` to `https://10.0.0.5:5001` and sends to `https://webapi/hooks` with both clients: the ordinary one reaches `10.0.0.5`, the webhook client must keep the host the user typed.


## Conclusion
`ConfigureHttpClientDefaults` in Aspire's `ServiceDefaults` adds a standard resilience handler and service discovery to every `HttpClient`, including the ones registered later in other projects. For calling our own services, that is the right default.

For a client that calls a URL somebody else chose, it is not: retried `POST`s that nobody records, a circuit breaker shared between all tenants, timeouts that override our own, and a user-typed host that may resolve to an internal service. One line, `ConfigureAdditionalHttpMessageHandlers((handlers, _) => handlers.Clear())`, takes them off, and a unit test with a control client keeps them off.

This is how the outgoing webhooks are built in [Blouppy Starter](https://starter.blouppy.com/), where every attempt is one request and the retry budget lives in the delivery row. The [webhooks module's documentation](https://docs.starter.blouppy.com/modules/webhooks/) explains the rest of the delivery pipeline.

*Thanks for reading! 🙂*
