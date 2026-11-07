---
templateKey: 'blog-post'
title: 'Implementing Rate Limiting Middleware in ASP.NET Core'
date: 2023-07-15T18:24:10.000Z
updated: 2026-11-07T09:00:00.000Z
author: Jimmy Boinembalome
authorimage: /img/jimmy.jpg
category: C#
topic: 'Security'
illustration: 1
categorycolor: bg-purple-100 text-purple-800
featuredpost: true
featuredimage: /img/implementing-rate-limiting-middleware-in-dotnet7.jpg
description: >-
  Explore how to effectively implement and configure the built-in rate limiting middleware of .NET 10 to secure your ASP.NET Core applications against potential threats.
tags:
  - Development
  - C#
  - ASP.NET Core
  - .NET 10
---

> **Updated November 2026:** updated for .NET 10. I fixed two mistakes of the first version (rejected requests now really get a 429, and attributes do not limit every request on their own), and added per-client limits, a global limiter and Minimal APIs.

Securing a web application is a multifaceted task, and a key part of this process is rate limiting.

In this article, we delve into the built-in rate limiting of ASP.NET Core (since .NET 7, and still the way to go in .NET 10), showcasing its capabilities, configuration, and various algorithms. 


## What is Rate Limiting?
Rate limiting is a technique for controlling the number of requests a client can make to a server within a certain timeframe. It's an essential aspect of securing web applications and APIs, as it helps to protect our application from Denial of Service (DoS) attacks, brute force attacks, and other forms of system abuse by limiting how often each client can call your API or service.


## Rate Limiting middleware in ASP.NET Core
In the past, implementing rate limiting in ASP.NET Core applications required the use of third-party packages such as `AspNetCoreRateLimit`. However, with the release of .NET 7, rate limiting is now a built-in feature, available as a middleware. 

The work is split between two namespaces:
- `System.Threading.RateLimiting` holds the primitives: the abstract base class `RateLimiter`, its implementations (`FixedWindowRateLimiter`, `SlidingWindowRateLimiter`, `TokenBucketRateLimiter`, `ConcurrencyLimiter`), `PartitionedRateLimiter` and their options. They are not tied to HTTP at all.
- `Microsoft.AspNetCore.RateLimiting` holds the middleware itself: `AddRateLimiter`, `UseRateLimiter`, `RateLimiterOptions`, the `AddFixedWindowLimiter`-style helpers and the `[EnableRateLimiting]`/`[DisableRateLimiting]` attributes. It ships with ASP.NET Core, so there is no package to install.

We can configure the middleware with several options, including the maximum number of requests allowed, the response status code, and the time window. 

We can define the rate limit depending on the HTTP method, the client IP address, and other factors. We even have the option of queueing requests instead of rejecting them.


## Configure Rate Limiting middleware
To add the rate limiting middleware to our ASP.NET Core application, we should first add the required services to the container. Then, to add the middleware to the pipeline, we need to call the `UseRateLimiter` extension method.

```csharp
using System.Threading.RateLimiting;
using Microsoft.AspNetCore.RateLimiting;

builder.Services.AddRateLimiter(options =>
{
    // Configure the middleware here
});

app.UseRateLimiter();
```

> **_Note:_** When the limits are attached to endpoints (as we will do below), `UseRateLimiter()` must come after routing. With `WebApplication`, routing runs at the start of the pipeline unless we call `UseRouting()` ourselves, so calling `UseRateLimiter()` before `MapControllers()` is enough.


## Rate Limiter Algorithms
The rate limiting middleware supports several algorithms, each with its own characteristics and use cases.

### Fixed Window
This algorithm divides the time into fixed-size windows and allows a certain number of requests in each window. 

```csharp
options.AddFixedWindowLimiter("fixed", options =>
{
    options.PermitLimit = 10;
    options.Window = TimeSpan.FromSeconds(10);
    options.QueueProcessingOrder = QueueProcessingOrder.OldestFirst;
    options.QueueLimit = 5;
});
```

We can think of this algorithm like a stopwatch that resets every 10 seconds (`TimeSpan.FromSeconds(10)`). Within each "window" of time, there is a maximum number of 10 requests (`options.PermitLimit = 10`) that can be made. Once that limit is reached, no more requests can be made until the stopwatch resets and a new window begins.

In the scenario above, clients have the ability to make up to 10 requests every 10 seconds. If they attempt to make more than this limit during the 10 seconds, up to 5 additional requests won't be immediately denied. Instead, these extra requests will be put on hold (`options.QueueLimit = 5`). When the next 10 seconds rolls around, these queued requests will be processed. Beyond that, requests are rejected.


### Sliding Window
This algorithm also divides the time into windows, but the window moves with each request. This prevents bursts of requests but is slightly more complex.

```csharp
options.AddSlidingWindowLimiter("sliding", options =>
{
    options.PermitLimit = 10;
    options.Window = TimeSpan.FromSeconds(10);
    options.SegmentsPerWindow = 2;
    options.QueueProcessingOrder = QueueProcessingOrder.OldestFirst;
    options.QueueLimit = 5;
});
```

In the **Fixed Window** algorithm, we have a fixed time window (10 seconds) and a maximum number of requests that can be made in that window (10 requests). Once those 10 requests have been made, no more requests can be made until the window resets and a new 10-second period begins.

The **Sliding Window** algorithm, on the other hand, adds a bit more flexibility. It still has a time window and a maximum number of requests, but it divides the window into smaller segments. In the provided code, the 10-second window is divided into 2 segments, each 5 seconds long.

Here is the key difference: in the **Sliding Window** algorithm, the window "slides" forward by one segment at each interval. So every 5 seconds, the window slides forward by 5 seconds. This means that the rate limit applies to the most recent 10 seconds, not a fixed 10-second period.


### Token Bucket
This algorithm allows a certain number of tokens (requests) to be used in a time period, and unused tokens are accumulated.

```csharp
options.AddTokenBucketLimiter("token", options =>
{
    options.TokenLimit = 100;
    options.ReplenishmentPeriod = TimeSpan.FromSeconds(10);
    options.TokensPerPeriod = 20;
    options.QueueProcessingOrder = QueueProcessingOrder.OldestFirst;
    options.QueueLimit = 5;
});
```

We can imagine a bucket that is constantly being filled with tokens at a steady rate. Each time a request is made, a token is removed from the bucket. If the bucket is empty, the request is denied. If there are unused tokens, they stay in the bucket, allowing for bursts of requests up to the number of tokens in the bucket.

This algorithm is useful if we want to allow occasional bursts of requests but limit the overall rate of requests.


### Concurrency
This last algorithm limits the number of concurrent requests. 

```csharp
options.AddConcurrencyLimiter("concurrency", options =>
{
    options.PermitLimit = 10;
    options.QueueProcessingOrder = QueueProcessingOrder.OldestFirst;
    options.QueueLimit = 5;
});
```

The Concurrency algorithm is like an elevator in a building. The elevator can only hold a certain number of people at once. If the elevator is full, no one else can enter until someone exits.

In the context of rate limiting, this means limiting the number of concurrent requests. This can be useful for limiting resource usage, such as database connections or CPU usage, rather than the rate of requests over time.


## Using Rate Limiting in a Controller
To apply rate limiting to a controller, we can use the `EnableRateLimiting` and `DisableRateLimiting` attributes on the controller or action method. `[EnableRateLimiting("fixed")]` applies the named policy to that controller or action only, and `[DisableRateLimiting]` turns rate limiting off for it.

> **_Note:_** In the first version of this article, I wrote that the middleware automatically applies the rules to all incoming HTTP requests. That is wrong: a named policy only applies where we attach it. An endpoint with no attribute (and no `RequireRateLimiting()`) is not limited at all, unless we set a `GlobalLimiter` (see below).

```csharp
[Route("api/[controller]")]
[ApiController]
public class CustomersController(ICustomerService customerService) : ControllerBase
{
    // GET: api/customers
    [EnableRateLimiting("fixed")]
    [HttpGet]
    public async Task<ActionResult<IEnumerable<CustomerDto>>> GetCustomers(CancellationToken cancellationToken)
    {
        var dtos = await customerService.GetCustomersAsync(cancellationToken);
        return Ok(dtos);
    }

    // GET api/customers/31a7ffcf-d099-4637-bd58-2a87641d1aaf
    [DisableRateLimiting]
    [HttpGet("{id:guid}")]
    public async Task<ActionResult<CustomerDto>> GetCustomerById(Guid id, CancellationToken cancellationToken)
    {
        var dto = await customerService.GetCustomerByIdAsync(id, cancellationToken);

        if (dto is null)
            return NotFound();

        return Ok(dto);
    }
}
```

Let's send 16 requests at once to `GET /api/customers`. The first 10 go through, the next 5 wait in the queue for the next window (about 10 seconds), and the last one is rejected:

```bash
for i in $(seq 16); do (curl -s -o /dev/null -w "%{http_code} %{time_total}s\n" http://localhost:5207/api/customers &); done
```

```
200 0.277599s
200 0.286004s
200 0.284591s
200 0.280942s
200 0.278505s
200 0.341280s
200 0.308032s
200 0.337269s
200 0.327419s
200 0.335289s
429 0.297340s
200 10.042149s
200 10.045569s
200 10.041420s
200 10.039114s
200 10.045058s
```


## Using Rate Limiting in a Minimal API
With Minimal APIs, there are no attributes on a method, so we call `RequireRateLimiting()` on the endpoint (or on a route group) instead. `DisableRateLimiting()` exists too.

```csharp
// GET: api/minimal/customers
app.MapGet("/api/minimal/customers", (ICustomerService customerService, CancellationToken cancellationToken) =>
        customerService.GetCustomersAsync(cancellationToken))
    .RequireRateLimiting("per-ip");
```


## Limiting per client
The policies above are shared: with `fixed`, the 10 requests per window are for **all** the clients together. One noisy client could use up the quota and every other client would be rejected. 😬 Most of the time, we want a limit **per client**. That is what partitions are for: `AddPolicy` takes a function that returns a `RateLimitPartition` for each request, and every partition key gets its own limiter.

```csharp
// One fixed window per client IP address: a noisy client cannot use up everybody else's quota.
options.AddPolicy("per-ip", httpContext =>
    RateLimitPartition.GetFixedWindowLimiter(
        partitionKey: httpContext.Connection.RemoteIpAddress?.ToString() ?? "unknown",
        factory: _ => new FixedWindowRateLimiterOptions
        {
            PermitLimit = 5,
            Window = TimeSpan.FromSeconds(10)
        }));
```

The client IP address is the usual key for anonymous traffic, with a few caveats:
- **Behind a reverse proxy or a load balancer**, `RemoteIpAddress` is the proxy's address, so every client shares one partition. Configure the [Forwarded Headers middleware](https://learn.microsoft.com/en-us/aspnet/core/host-and-deploy/proxy-load-balancer) with the proxies you trust (and call `UseForwardedHeaders()` before `UseRateLimiter()`), never trust `X-Forwarded-For` from anyone.
- Many users can share one IP address (an office, a mobile network), and one attacker can use many. For authenticated requests, a user id (`httpContext.User.Identity?.Name`) or an API key is a better key.
- Each partition keeps a limiter in memory, and the limits are **per instance**: with three replicas, a client gets three times the quota. A shared limit needs a distributed store (Redis, for example).


## Limiting every request: the Global Limiter
If we want a limit that applies to every request, whatever the endpoint, we set `GlobalLimiter`. It runs before the endpoint's own policy, and a request must get through both:

```csharp
// Applies to every request, on top of the named policy of the endpoint (if any).
options.GlobalLimiter = PartitionedRateLimiter.Create<HttpContext, string>(httpContext =>
    RateLimitPartition.GetFixedWindowLimiter(
        partitionKey: httpContext.Connection.RemoteIpAddress?.ToString() ?? "unknown",
        factory: _ => new FixedWindowRateLimiterOptions
        {
            PermitLimit = 100,
            Window = TimeSpan.FromMinutes(1)
        }));
```

With 120 requests to `/openapi/v1.json`, an endpoint with no policy of its own, the global limiter lets 100 of them through (one was used when the app started). And `[DisableRateLimiting]` turns off the global limiter as well, so 120 requests to `GET /api/customers/{id}` all succeed:

```
== 120 x GET /api/customers/{id} (DisableRateLimiting)
    120 200
== 120 x GET /openapi/v1.json (global limiter only)
     99 200
     21 429
```


## Bonus: Custom Status Code and Response
By default, when the rate limit is exceeded, the middleware returns a HTTP Status Code 503 "Service Unavailable". However, we can configure the middleware to return a HTTP Status Code 429 "Too Many Requests" with `RejectionStatusCode`, and a custom message (and a `Retry-After` header) with `OnRejected`:

```csharp
options.RejectionStatusCode = StatusCodes.Status429TooManyRequests;

options.OnRejected = async (context, token) =>
{
    string errorMessage;
    if (context.Lease.TryGetMetadata(MetadataName.RetryAfter, out var retryAfter))
    {
        context.HttpContext.Response.Headers.RetryAfter =
            ((int)Math.Ceiling(retryAfter.TotalSeconds)).ToString(CultureInfo.InvariantCulture);

        errorMessage = "Too many requests. " +
                       $"Please try again after {retryAfter.TotalSeconds} second(s). " +
                       "You can read more information about rate limits at https://example.org/docs/ratelimiting.";

        await context.HttpContext.Response.WriteAsync(errorMessage, token);
        return;
    }

    errorMessage = "Too many requests. " +
                   "Please try again later. " +
                   "You can read more information about rate limits at https://example.org/docs/ratelimiting.";
    await context.HttpContext.Response.WriteAsync(errorMessage, token);
};
```

> **_Note:_** The first version of this article only showed `OnRejected`, which writes the message but never changes the status code, so the client still got a 503. The middleware sets the response status to `RejectionStatusCode` before calling `OnRejected`: that line is the one that turns it into a 429. (We could also set `context.HttpContext.Response.StatusCode` inside `OnRejected`.)

Now, if we exceed the number of requests, we will get a 429 error. Here is the 6th request within 10 seconds to `/api/minimal/customers`:

```
HTTP/1.1 429 Too Many Requests
Date: Sat, 07 Nov 2026 08:09:46 GMT
Server: Kestrel
Retry-After: 10
Transfer-Encoding: chunked

Too many requests. Please try again after 10 second(s). You can read more information about rate limits at https://example.org/docs/ratelimiting.
```


## Conclusion
Rate limiting is a crucial aspect of securing web applications and APIs. With the built-in rate limiting middleware of ASP.NET Core, it's now easier than ever to implement effective rate limiting in your ASP.NET Core applications. 

In this article, we have seen 4 algorithms, **Fixed Window**, **Sliding Window**, **Token Bucket** and **Concurrency**. Each of these algorithms has its own use cases, and the best one to use depends on your specific needs. You might even use different algorithms for different parts of your application. The key is to understand how each algorithm works and choose the one that best fits your requirements.

By understanding and properly configuring the rate limiting middleware, you can protect your application from abuse and ensure fair usage of your resources.

Source code of the article: [Github source code](https://github.com/jboinembalome/ImplementingRateLimitingMiddleware)

*Thanks for reading! 🙂*