---
templateKey: 'blog-post'
title: 'Problem Details everywhere: API errors in ASP.NET Core that leak nothing'
date: 2026-06-12T09:00:00.000Z
author: Jimmy Boinembalome
authorimage: /img/jimmy.jpg
category: C#
topic: 'Security'
illustration: 1
categorycolor: bg-purple-100 text-purple-800
featuredpost: true
description: >-
  Learn how to answer every ASP.NET Core API error with RFC 9457 problem details, using chained exception handlers, status code pages and error codes that an Angular client can map.
tags:
  - Development
  - C#
  - ASP.NET Core
  - Security
---

Most APIs start with three error formats. A validation failure returns a dictionary, a missing resource returns an empty `404`, and an unhandled exception returns whatever the framework prints, sometimes with a stack trace and a SQL error naming a table. The client guesses from the status code, and an attacker learns the shape of the database.

[RFC 9457 problem details](https://www.rfc-editor.org/rfc/rfc9457) give every error one shape. It replaced RFC 7807 in 2023 with the same format. A problem is a JSON object served as `application/problem+json`, with `type`, `title`, `status`, `detail` and `instance`. Anything else is an **extension member**, which is where a `traceId` or an application `code` goes.


## Three registrations
`AddProblemDetails()` registers `IProblemDetailsService`, the writer every other piece uses. Two middleware do the rest:

```csharp
builder.Services.AddExceptionHandler<KnownExceptionHandler>();
builder.Services.AddExceptionHandler<UnhandledExceptionHandler>();
builder.Services.AddProblemDetails();

var app = builder.Build();

app.UseExceptionHandler();
app.UseStatusCodePages();
```

`UseExceptionHandler()` catches what the rest of the pipeline throws and asks each `IExceptionHandler` **in registration order**. The first that returns `true` has written the response. `UseStatusCodePages()` fills in error responses that have **no body**, such as an unmatched route or a `Forbid()`, with a problem. Both go first in the pipeline, so they wrap everything else.

A handler writes through `IProblemDetailsService` rather than serializing the object itself. The response then gets the right content type, a `type` filled in from the status, and a **`traceId`** extension. That id is what support pastes into the log search. An MVC exception filter is no substitute: it only sees exceptions thrown inside controller actions, so a failure in a middleware or a minimal endpoint escapes it.

`AddExceptionHandler<T>` registers the handler as a singleton, so it cannot take a `DbContext` in its constructor.


## Leaking nothing
The rule: **`detail` only carries a message you wrote**. A `NotFoundException("Workspace", 12)` that you declare has a message meant for the caller. An `NpgsqlException` or a third-party SDK's exception has a message meant for you: a table name, a connection string fragment, an internal URL. So the last handler in the chain writes a fixed title, no `detail`, and logs the exception. This is the one in [Blouppy Starter](https://starter.blouppy.com/):

```csharp
internal sealed class UnhandledExceptionHandler(
    IProblemDetailsService problemDetailsService,
    ILogger<UnhandledExceptionHandler> logger) : IExceptionHandler
{
    public async ValueTask<bool> TryHandleAsync(
        HttpContext httpContext,
        Exception exception,
        CancellationToken cancellationToken)
    {
        logger.LogError(exception, "Unhandled exception occurred");

        httpContext.Response.StatusCode = StatusCodes.Status500InternalServerError;

        await problemDetailsService.WriteAsync(new ProblemDetailsContext
        {
            HttpContext = httpContext,
            Exception = exception,
            ProblemDetails = new ProblemDetails { Status = 500, Title = "Server error" }
        });

        return true;
    }
}
```

The snippet inlines what the Starter does through a small extension. The log line matters more since .NET 10: the middleware no longer logs an exception that a handler reports as handled. A catch-all that returns `true` without logging makes failures invisible.

The Starter got two things wrong here at first, and both are worth checking in your own code. Its handlers called `WriteAsJsonAsync`, so the bodies had the problem shape but went out as `application/json`, with no `traceId`. And the catch-all logged `{Message}` with `exception.Message`, which put the third-party message in a structured field. Both are fixed: every handler writes through `IProblemDetailsService`, and the log message is constant.

Never run the developer exception page outside Development: it shows the stack trace by design.


## Statuses, then codes
The handler before the catch-all knows a closed list of exceptions and returns `false` for anything else. Each gets a status for what the caller can do about it. A `SubscriptionStateException` is a `409`: the request was well formed and arrived at the wrong moment. A `BillingNotConfiguredException` is a `503`: not the caller's mistake, and nothing a retry fixes. The Starter matches on the exception's type **or any of its base types**, so a subclass of a known exception does not fall through to a `500`.

Sometimes one status covers several situations. In the Starter's AI features, a `403` can mean an administrator turned AI off, the person used their monthly allowance, or the organization's own key was refused. Each calls for a different message, so the problem carries a `code`, and `resetsAt` when the allowance comes back. Simplified from the Starter's table of refusals:

```csharp
var problem = new ProblemDetails
{
    Status = StatusCodes.Status403Forbidden,
    Title = "You have used your AI for this month.",
    Extensions = { ["code"] = "ai.personalLimitReached" }
};

problem.Extensions["resetsAt"] = resetsAt;
```

None of these refusals is a `429`, on purpose: a client or a proxy reads `429` as "retry shortly", and a monthly limit is not that. The `title` is English and for developers. The `code` is the contract, and the client translates it.

Validation does not throw at all. A write service returns a `ValidationResult<T>` whose errors are a field-to-messages dictionary, and the controller answers a `ValidationProblemDetails` with it. An invalid input is an expected outcome, not an exception.


## Reading the code in Angular
The Angular app has one functional interceptor for every failure. A `403` opens the forbidden page, a `401` goes back to the [BFF session](/blog/2026-05-10-keep-the-access-token-out-of-the-browser-bff-angular-yarp/), and anything else shows a generic, translated toast. The server's `title` is never displayed. A call site that knows better opts out of the toast for some statuses through an `HttpContextToken`, and maps the code:

```ts
const problem = error.error as { code?: AiErrorCode; resetsAt?: string } | null;
const failure = (problem?.code ? FAILURES[problem.code] : undefined) ?? 'failed';
```

`AiErrorCode` is a union of the server's codes and `FAILURES` is a `Record<AiErrorCode, ...>`, so the compiler asks for a mapping of every code. An unknown code, from a newer server, falls back to `'failed'`.

Codes are a contract. Once a client maps `ai.personalLimitReached`, renaming it is a breaking change, and nothing but review checks that the C# table and the TypeScript union agree. Keep them few and namespaced.

For an internal API with one client, the three registrations alone already give every error the RFC shape, a `traceId` and no stack trace, with no handler at all. Add handlers when a domain exception deserves a status other than `500`, and codes when one status covers outcomes the client treats differently.


## References
- [RFC 9457: Problem Details for HTTP APIs](https://www.rfc-editor.org/rfc/rfc9457) — IETF: the format, its members and extension rules.
- [Handle errors in ASP.NET Core APIs](https://learn.microsoft.com/aspnet/core/fundamentals/error-handling-api) — Microsoft Learn: `AddProblemDetails`, `IProblemDetailsService` and status code pages.
- [Handle errors in ASP.NET Core](https://learn.microsoft.com/aspnet/core/fundamentals/error-handling) — Microsoft Learn: `UseExceptionHandler`, `IExceptionHandler` and handler ordering.
- [Intercepting requests and responses](https://angular.dev/guide/http/interceptors) — Angular: functional interceptors and `HttpContextToken`.
