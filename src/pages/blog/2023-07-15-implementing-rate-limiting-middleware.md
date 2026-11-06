---
templateKey: 'blog-post'
title: 'Implementing Rate Limiting Middleware in .NET 7'
date: 2023-07-15T18:24:10.000Z
author: Jimmy Boinembalome
authorimage: /img/jimmy.jpg
category: C#
topic: 'Security'
illustration: 1
categorycolor: bg-purple-100 text-purple-800
featuredpost: true
featuredimage: /img/implementing-rate-limiting-middleware-in-dotnet7.jpg
description: >-
  Explore how to effectively implement and configure rate limiting in .NET 7 to secure your ASP.NET Core applications against potential threats.
tags:
  - Development
  - C#
  - ASP.NET Core
  - .NET 7
---
  
Securing a web application is a multifaceted task, and a key part of this process is rate limiting.

In this article, we delve into inbuilt rate limiting with .NET 7, showcasing its capabilities, configuration, and various algorithms. 


## What is Rate Limiting?
Rate limiting is a technique for controlling the number of requests a client can make to a server within a certain timeframe. It's an essential aspect of securing web applications and APIs, as it helps to protect our application from Denial of Service (DoS) attacks, brute force attacks, and other forms of system abuse by limiting how often each client can call your API or service.


## Rate Limiting middleware in .NET 7
In the past, implementing rate limiting in ASP.NET Core applications required the use of third-party packages such as `AspNetCoreRateLimit`. However, with the release of .NET 7, rate limiting is now a built-in feature, available as a middleware. 

The rate limiting middleware in .NET 7 is part of the `System.Threading.RateLimiting` namespace. The main type is the abstract base class `RateLimiter`, which provides several features. We can configure the `RateLimiter` with several options, including the maximum number of requests allowed, the response status code, and the time window. 

We can define the rate limit depending on the HTTP method, the client IP address, and other factors. We even have the option of queueing requests instead of rejecting them.


## Configure Rate Limiting middleware
To add the rate limiting middleware to our ASP.NET Core 7 application, we should first add the required services to the container. Then, to add the middleware to the pipeline, we need to call the `UseRateLimiter` extension method.

 ```csharp
builder.Services.AddRateLimiter(options =>
{
    // Configure the middleware here
});

app.UseRateLimiter();
 ```


## Rate Limiter Algorithms
The rate limiting middleware in .NET 7 supports several algorithms, each with its own characteristics and use cases.

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

In the scenario above, clients have the ability to make up to 10 requests every 10 seconds. If they attempt to make more than this limit during the 10 seconds, up to 5 additional requests won't be immediately denied. Instead, these extra requests will be put on hold (`options.QueueLimit = 5`). When the next 10 seconds rolls around, these queued requests will be processed.


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
To apply rate limiting to a controller, we can use the `EnableRateLimiting` and `DisableRateLimiting` attributes on the controller or action method. The middleware will automatically apply the rate limiting rules to all incoming HTTP requests.

 ```csharp
[Route("api/[controller]")]
[ApiController]
public class CustomersController : ControllerBase
{
    private readonly ICustomerService _customerService;

    public CustomersController(ICustomerService customerService)
    {
        _customerService = customerService;
    }

    [EnableRateLimiting("fixed")]
    [HttpGet]
    public async Task<ActionResult<IEnumerable<CustomerDto>>> GetCustomers(CancellationToken cancellationToken)
    {
        var dtos = await _customerService.GetCustomersAsync(cancellationToken);
        return Ok(dtos);
    }

    [DisableRateLimiting]
    [HttpGet("{id}")]
    public async Task<ActionResult<CustomerDto>> GetCustomerById(Guid id, CancellationToken cancellationToken)
    {
        var dto = await _customerService.GetCustomerByIdAsync(id, cancellationToken);

        if (dto is null) 
            return NotFound();

        return Ok(dto);
    }
}
  ```

## Bonus: Custom Status Code and Response
By default, when the rate limit is exceeded, the middleware returns a HTTP Status Code 503 "Service Unavailable". However, we can configure the middleware to return a HTTP Status Code 429 "Too Many Requests" with a custom message.

 ```csharp
options.OnRejected = async (context, token) =>
{

    string errorMessage = string.Empty;
    if (context.Lease.TryGetMetadata(MetadataName.RetryAfter, out var retryAfter))
    {
        errorMessage = "Too many requests. " +
                        $"Please try again after {retryAfter.TotalSeconds} second(s). " +
                        "You can read more information about rate limits at https://example.org/docs/ratelimiting.";

        await context.HttpContext.Response.WriteAsync(errorMessage, token);
        return;
    }

    errorMessage = "Too many requests." +
                    "Please try later again." +
                    "You can read more information about rate limits at https://example.org/docs/ratelimiting.";
    await context.HttpContext.Response.WriteAsync(errorMessage, token);
};
```

Now, if we exceed the number of requests, we will get a 429 error.


## Conclusion
Rate limiting is a crucial aspect of securing web applications and APIs. With the built-in rate limiting middleware in .NET 7, it's now easier than ever to implement effective rate limiting in your ASP.NET Core applications. 

In this article, we have seen 4 algorithms, **Fixed Window**, **Sliding Window**, **Token Bucket** and **Concurrency**. Each of these algorithms has its own use cases, and the best one to use depends on your specific needs. You might even use different algorithms for different parts of your application. The key is to understand how each algorithm works and choose the one that best fits your requirements.

By understanding and properly configuring the rate limiting middleware, you can protect your application from abuse and ensure fair usage of your resources.

Source code of the article: [Github source code](https://github.com/jboinembalome/ImplementingRateLimitingMiddleware)

*Thanks for reading! 🙂*