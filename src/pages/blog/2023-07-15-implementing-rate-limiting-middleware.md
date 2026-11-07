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
  Learn how to configure ASP.NET Core's built-in rate limiting in .NET 10: the four algorithms, per-client partitions, a global limiter and 429 responses.
tags:
  - Development
  - C#
  - ASP.NET Core
  - .NET 10
---

> **Updated November 2026:** updated for .NET 10. I fixed two mistakes of the first version (rejected requests now really get a 429, and attributes do not limit every request on their own), and added per-client limits, a global limiter and Minimal APIs.

In this article, we look at the [built-in rate limiting middleware](https://learn.microsoft.com/aspnet/core/performance/rate-limit) of ASP.NET Core, available since .NET 7: its algorithms, and how to apply it to controllers and Minimal APIs.

## What is Rate Limiting?
Rate limiting controls how many requests a client can make within a given time. It protects an API from denial of service, brute force and other abuse. The OWASP API Security Top 10 lists its absence as [Unrestricted Resource Consumption](https://owasp.org/API-Security/editions/2023/en/0xa4-unrestricted-resource-consumption/).

## Rate Limiting middleware in ASP.NET Core
Before .NET 7, rate limiting required a third-party package such as `AspNetCoreRateLimit`. It is now [built in](https://devblogs.microsoft.com/dotnet/announcing-rate-limiting-for-dotnet/), in two namespaces:
- [`System.Threading.RateLimiting`](https://learn.microsoft.com/dotnet/api/system.threading.ratelimiting) holds the limiters (`FixedWindowRateLimiter`, `PartitionedRateLimiter`...) and their options. They are not tied to HTTP.
- [`Microsoft.AspNetCore.RateLimiting`](https://learn.microsoft.com/dotnet/api/microsoft.aspnetcore.ratelimiting) holds the middleware (`AddRateLimiter`, `UseRateLimiter`, `RateLimiterOptions`) and the `[EnableRateLimiting]`/`[DisableRateLimiting]` attributes. It ships with ASP.NET Core: there is no package to install.

## Configure Rate Limiting middleware
Register the services, then add the middleware to the pipeline with `UseRateLimiter`:

```csharp
using System.Threading.RateLimiting;
using Microsoft.AspNetCore.RateLimiting;

builder.Services.AddRateLimiter(options =>
{
    // Configure the policies here
});

app.UseRateLimiter();
```

> **_Note:_** When limits are attached to endpoints, as below, `UseRateLimiter()` must run after routing. `WebApplication` adds routing at the start of the pipeline unless you call `UseRouting()` yourself, so calling `UseRateLimiter()` before `MapControllers()` is enough.

## Rate Limiter Algorithms
Each `Add...Limiter` call below registers a **named policy** with one of the four algorithms.

### Fixed Window
This algorithm divides time into fixed windows and allows a number of requests in each:

```csharp
options.AddFixedWindowLimiter("fixed", options =>
{
    options.PermitLimit = 10;
    options.Window = TimeSpan.FromSeconds(10);
    options.QueueProcessingOrder = QueueProcessingOrder.OldestFirst;
    options.QueueLimit = 5;
});
```

Each 10-second window (`Window`) allows 10 requests (`PermitLimit`). Up to 5 more wait in a queue (`QueueLimit`) until the next window starts. Any request beyond that is rejected.

### Sliding Window
This algorithm also uses a window, but divides it into segments:

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

Here the 10-second window has 2 segments of 5 seconds. Every 5 seconds, the window slides forward by one segment, so the limit applies to the last 10 seconds rather than to a fixed period. This avoids the burst a fixed window allows at the boundary between two windows.

### Token Bucket
This algorithm adds tokens to a bucket at a steady rate:

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

Each request takes a token; when the bucket is empty, requests are queued or rejected. Unused tokens accumulate up to `TokenLimit`, which allows occasional bursts while limiting the overall rate.

### Concurrency
This algorithm limits the number of requests in progress at the same time:

```csharp
options.AddConcurrencyLimiter("concurrency", options =>
{
    options.PermitLimit = 10;
    options.QueueProcessingOrder = QueueProcessingOrder.OldestFirst;
    options.QueueLimit = 5;
});
```

Like an elevator, when it is full nobody enters until someone leaves. It protects a resource, such as database connections or CPU, rather than limiting a rate.

## Using Rate Limiting in a Controller
`[EnableRateLimiting("fixed")]` applies a named policy to a controller or an action, and `[DisableRateLimiting]` turns rate limiting off for it.

> **_Note:_** The first version of this article said that the middleware applies the rules to every incoming request. That is wrong: a named policy only applies where you attach it. An endpoint without a policy is not limited, unless you set a `GlobalLimiter` (see below).

```csharp
[Route("api/[controller]")]
[ApiController]
public sealed class CustomersController(ICustomerService customerService) : ControllerBase
{
    [EnableRateLimiting("fixed")]
    [HttpGet]
    [ProducesResponseType(StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status429TooManyRequests)]
    public async Task<ActionResult<IReadOnlyList<CustomerDto>>> GetCustomers(CancellationToken cancellationToken)
    {
        var dtos = await customerService.GetCustomersAsync(cancellationToken);
        return Ok(dtos);
    }

    [DisableRateLimiting]
    [HttpGet("{id:guid}")]
    [ProducesResponseType(StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status404NotFound)]
    public async Task<ActionResult<CustomerDto>> GetCustomerById(Guid id, CancellationToken cancellationToken)
    {
        // ...
    }
}
```

`[ProducesResponseType]` lists the 429 and 404 responses in the [OpenAPI document](https://learn.microsoft.com/aspnet/core/fundamentals/openapi/aspnetcore-openapi). Let's send 16 requests at once to `GET /api/customers`. The first 10 go through, the next 5 wait in the queue for the next window (about 10 seconds), and the last one is rejected:

```bash
for i in $(seq 16); do (curl -s -o /dev/null -w "%{http_code} %{time_total}s\n" http://localhost:5207/api/customers &); done
```

```
200 0.385094s
200 0.412106s
200 0.399785s
200 0.397099s
200 0.406528s
200 0.558784s
200 0.502623s
200 0.516216s
200 0.511728s
200 0.522055s
429 0.519069s
200 10.160396s
200 10.234152s
200 10.175415s
200 10.170592s
200 10.174853s
```

## Using Rate Limiting in a Minimal API
A Minimal API endpoint calls `RequireRateLimiting()` instead, on the endpoint or on a route group (`DisableRateLimiting()` exists too):

```csharp
app.MapGet("/api/minimal/customers", (ICustomerService customerService, CancellationToken cancellationToken) =>
        customerService.GetCustomersAsync(cancellationToken))
    .RequireRateLimiting("per-ip")
    .ProducesProblem(StatusCodes.Status429TooManyRequests);
```

## Limiting per client
The policies above are shared: with `fixed`, the 10 requests per window are for **all** clients together, so one noisy client can get everybody else rejected. To limit **per client**, `AddPolicy` takes a function that returns a `RateLimitPartition` for each request; each partition key gets its own limiter.

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

The client IP address is the usual key for anonymous traffic, with three caveats:
- **Behind a reverse proxy**, `RemoteIpAddress` is the proxy's address, so every client shares one partition. Configure the [Forwarded Headers middleware](https://learn.microsoft.com/aspnet/core/host-and-deploy/proxy-load-balancer) with the proxies you trust, before `UseRateLimiter()`. Never trust `X-Forwarded-For` from anyone.
- Many users can share one IP address, and one attacker can use many. For authenticated requests, a user id (`httpContext.User.Identity?.Name`) or an API key is a better key.
- Limits are kept in memory **per instance**: with three replicas, a client gets three times the quota. A shared limit needs a distributed store, such as Redis.

## Limiting every request: the Global Limiter
For a limit that applies to every request, whatever the endpoint, set `GlobalLimiter`. It runs before the endpoint's own policy, and a request must get through both:

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

On a freshly started app, 120 requests to `/openapi/v1.json`, which has no policy of its own, give 100 successes and 20 rejections. `[DisableRateLimiting]` also turns off the global limiter:

```
== 120 x GET /openapi/v1.json (global limiter only)
    100 200
     20 429
== 120 x GET /api/customers/{id} (DisableRateLimiting)
    120 200
```

## Custom Status Code and Response
By default, a rejected request gets **503 Service Unavailable**. Set [`RejectionStatusCode`](https://learn.microsoft.com/dotnet/api/microsoft.aspnetcore.ratelimiting.ratelimiteroptions) to return [**429 Too Many Requests**](https://www.rfc-editor.org/rfc/rfc6585#section-4), and use `OnRejected` to add a [`Retry-After`](https://www.rfc-editor.org/rfc/rfc9110#section-10.2.3) header and a [problem details](https://learn.microsoft.com/aspnet/core/fundamentals/error-handling-api) body:

```csharp
options.RejectionStatusCode = StatusCodes.Status429TooManyRequests;

options.OnRejected = async (context, _) =>
{
    var detail = "Too many requests. Please try again later.";
    if (context.Lease.TryGetMetadata(MetadataName.RetryAfter, out var retryAfter))
    {
        var seconds = (int)Math.Ceiling(retryAfter.TotalSeconds);
        context.HttpContext.Response.Headers.RetryAfter = seconds.ToString(CultureInfo.InvariantCulture);
        detail = $"Too many requests. Please try again after {seconds} second(s).";
    }

    await TypedResults.Problem(detail: detail, statusCode: StatusCodes.Status429TooManyRequests)
        .ExecuteAsync(context.HttpContext);
};
```

`TypedResults.Problem` writes an [RFC 9457](https://www.rfc-editor.org/rfc/rfc9457) body through the service that `builder.Services.AddProblemDetails()` registers, so the 429 looks like the API's other errors. Only the fixed window and token bucket limiters attach `RetryAfter` to a rejected lease; the sliding window and concurrency limiters do not, hence the fallback message.

> **_Note:_** The first version of this article only set `OnRejected`, so the client still got a 503: the middleware sets the status to `RejectionStatusCode` before it calls `OnRejected`.

Here is the 6th request within 10 seconds to `/api/minimal/customers`:

```
HTTP/1.1 429 Too Many Requests
Content-Type: application/problem+json
Retry-After: 10

{"title":"Too Many Requests","status":429,"detail":"Too many requests. Please try again after 10 second(s).","traceId":"00-f09de91dab66c1fec3911a9646dcb8e9-022fe0ae2d6b4c47-00"}
```

## Conclusion
The built-in middleware covers four algorithms: **Fixed Window**, **Sliding Window**, **Token Bucket** and **Concurrency**. Pick the one that matches what you protect, a rate or a resource, partition it per client, and add a global limiter as a safety net.

Source code of the article: [GitHub source code](https://github.com/jboinembalome/ImplementingRateLimitingMiddleware)

## References
- [Rate limiting middleware in ASP.NET Core](https://learn.microsoft.com/aspnet/core/performance/rate-limit) — the official guide: algorithms, policies, partitions and middleware order.
- [RateLimiterOptions](https://learn.microsoft.com/dotnet/api/microsoft.aspnetcore.ratelimiting.ratelimiteroptions) — `RejectionStatusCode`, `OnRejected` and `GlobalLimiter`.
- [System.Threading.RateLimiting](https://learn.microsoft.com/dotnet/api/system.threading.ratelimiting) — the limiter primitives and their options.
- [Configure ASP.NET Core to work with proxy servers and load balancers](https://learn.microsoft.com/aspnet/core/host-and-deploy/proxy-load-balancer) — the Forwarded Headers middleware.
- [Handle errors in ASP.NET Core APIs](https://learn.microsoft.com/aspnet/core/fundamentals/error-handling-api) — `AddProblemDetails` and the problem details service.
- [Generate OpenAPI documents](https://learn.microsoft.com/aspnet/core/fundamentals/openapi/aspnetcore-openapi) — the built-in `Microsoft.AspNetCore.OpenApi` package.
- [Announcing Rate Limiting for .NET](https://devblogs.microsoft.com/dotnet/announcing-rate-limiting-for-dotnet/) — the .NET team's introduction of the APIs.
- [RFC 6585, section 4](https://www.rfc-editor.org/rfc/rfc6585#section-4) — the 429 Too Many Requests status code.
- [RFC 9110, section 10.2.3](https://www.rfc-editor.org/rfc/rfc9110#section-10.2.3) — the `Retry-After` header.
- [RFC 9457](https://www.rfc-editor.org/rfc/rfc9457) — Problem Details for HTTP APIs.
- [OWASP API4:2023 Unrestricted Resource Consumption](https://owasp.org/API-Security/editions/2023/en/0xa4-unrestricted-resource-consumption/) — the risk rate limiting mitigates.
