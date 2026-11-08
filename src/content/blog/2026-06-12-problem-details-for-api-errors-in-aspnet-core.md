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

Most APIs start with three error formats. A validation failure returns a dictionary, a missing resource returns an empty `404`, and an unhandled exception returns whatever the framework prints, sometimes with a stack trace and a SQL error naming a table. The client then guesses from the status code, and an attacker learns the shape of the database.

In this article, we will give every error the same shape, [RFC 9457 problem details](https://www.rfc-editor.org/rfc/rfc9457), from three sources: chained `IExceptionHandler`s for exceptions, status code pages for empty error responses and `ValidationProblemDetails` for `400`s. Then we will add a `code` the client can rely on, and read it in Angular with one interceptor and a few lines per call site.


## The format: RFC 9457
RFC 9457 replaced RFC 7807 in 2023. The format is the same; the new RFC clarifies extensions and multiple problems, and creates a registry of common problem types. A problem is a JSON object served as `application/problem+json`, with five standard members:

- `type`: a URI that identifies the kind of problem, `about:blank` when absent.
- `title`: a short, human-readable summary of that kind of problem.
- `status`: the HTTP status code, repeated in the body.
- `detail`: an explanation of this occurrence.
- `instance`: a URI for this occurrence.

Anything else is an **extension member**. That is where a `traceId` or an application `code` goes:

```json
{
  "type": "https://tools.ietf.org/html/rfc9110#section-15.5.5",
  "title": "The specified resource was not found.",
  "status": 404,
  "detail": "Workspace (12) is not found.",
  "code": "workspace.notFound",
  "traceId": "00-3f2a9c...-01"
}
```

ASP.NET Core models it as `ProblemDetails`, with an `Extensions` dictionary, and `ValidationProblemDetails`, which adds an `errors` dictionary of field names to messages.


## The pipeline: three registrations
`AddProblemDetails()` registers `IProblemDetailsService`, the writer every other piece uses. Then the middleware:

```csharp
builder.Services.AddExceptionHandler<NotFoundExceptionHandler>();
builder.Services.AddExceptionHandler<UnhandledExceptionHandler>();
builder.Services.AddProblemDetails();

var app = builder.Build();

app.UseExceptionHandler();
app.UseStatusCodePages();
```

- `UseExceptionHandler()` catches what the rest of the pipeline throws and asks each registered `IExceptionHandler` in **registration order**. The first one that returns `true` has written the response. If none does, the middleware writes a generic `500` problem through `IProblemDetailsService`.
- `UseStatusCodePages()` fills in responses between `400` and `599` that have **no body**: an unmatched route, a `Forbid()`, a `return NotFound()`. With `AddProblemDetails()` registered, that body is a problem too.
- Both go **first** in the pipeline, so that they wrap everything else.

A handler implements one method:

```csharp
internal sealed class NotFoundExceptionHandler(
    IProblemDetailsService problemDetailsService) : IExceptionHandler
{
    public async ValueTask<bool> TryHandleAsync(
        HttpContext httpContext,
        Exception exception,
        CancellationToken cancellationToken)
    {
        if (exception is not NotFoundException notFound)
        {
            return false;
        }

        httpContext.Response.StatusCode = StatusCodes.Status404NotFound;

        return await problemDetailsService.TryWriteAsync(new ProblemDetailsContext
        {
            HttpContext = httpContext,
            Exception = exception,
            ProblemDetails = new ProblemDetails
            {
                Title = "The specified resource was not found.",
                Detail = notFound.Message,
                Extensions = { ["code"] = "resource.notFound" }
            }
        });
    }
}
```

Going through `IProblemDetailsService` rather than serializing the object ourselves has two benefits: the response gets the `application/problem+json` content type, and the default writer fills in `type` from the status code and adds a **`traceId`** extension, the current activity's id or the request's `TraceIdentifier`. That id is what support pastes into the log search. Anything every problem should carry goes in one place:

```csharp
builder.Services.AddProblemDetails(options =>
    options.CustomizeProblemDetails = context =>
        context.ProblemDetails.Instance =
            $"{context.HttpContext.Request.Method} {context.HttpContext.Request.Path}");
```

`AddExceptionHandler<T>` registers the handler as a **singleton**, so it cannot take a scoped service, a `DbContext` for instance, in its constructor.

This replaces the two older techniques. A custom middleware with a `try`/`catch` around `next()` does the same job with more code and no ordering between handlers. An MVC exception filter only sees exceptions thrown inside controller actions, so a failure in authentication, a minimal API endpoint or another middleware escapes it.


## Leaking nothing
The rule is simple: **`detail` only carries a message we wrote**. An exception type that we declare, `NotFoundException("Workspace", 12)`, has a message meant for the caller. An `NpgsqlException`, a `NullReferenceException` or a third-party SDK's exception has a message meant for us: a table name, a connection string fragment, an internal URL. The catch-all handler therefore writes a fixed title, no `detail`, and logs the exception:

```csharp
internal sealed class UnhandledExceptionHandler(
    ILogger<UnhandledExceptionHandler> logger) : IExceptionHandler
{
    public async ValueTask<bool> TryHandleAsync(
        HttpContext httpContext,
        Exception exception,
        CancellationToken cancellationToken)
    {
        logger.LogError(exception, "Unhandled exception occurred: {Message}", exception.Message);

        httpContext.Response.StatusCode = StatusCodes.Status500InternalServerError;

        await httpContext.Response.WriteAsJsonAsync(new ProblemDetails
        {
            Status = StatusCodes.Status500InternalServerError,
            Title = "Server error"
        }, cancellationToken);

        return true;
    }
}
```

The log line matters more since .NET 10: the exception handler middleware no longer logs an exception that an `IExceptionHandler` reports as handled. A catch-all that returns `true` without logging makes failures invisible. `ExceptionHandlerOptions.SuppressDiagnosticsCallback` restores the old behaviour when we prefer it.

Two more leaks to close. The developer exception page shows the stack trace by design, so it must never run outside Development. And a `500` caused by our own misconfiguration still deserves a fixed message to the public: the details go in the log, found through the `traceId`.


## The real example: Blouppy Starter
[Blouppy Starter](https://starter.blouppy.com/) wires the pipeline in one extension of `Blouppy.Web`, a [composition root](/blog/2026-05-04-hexagonal-architecture-in-dotnet/) that registers every adapter:

```csharp
public static class ServiceCollectionExtensions
{
    extension(IServiceCollection services)
    {
        public IServiceCollection AddErrorServices()
        {
            services.AddExceptionHandler<GlobalExceptionHandler>();
            services.AddExceptionHandler<UnhandledExceptionHandler>();

            services.AddProblemDetails();

            return services;
        }
    }
}
```

`UseExceptionHandler()` and `UseStatusCodePages()` are the first middleware after HSTS, before routing and authentication. `UnhandledExceptionHandler` is the class shown above, word for word. The order of registration is the design: `GlobalExceptionHandler` knows a closed list of exceptions and returns `false` for anything else, and `UnhandledExceptionHandler` takes the rest.

`GlobalExceptionHandler` maps each known exception type to a status, chosen for what the caller can do about it:

```csharp
internal sealed class GlobalExceptionHandler : IExceptionHandler
{
    private readonly Dictionary<Type, Func<HttpContext, Exception, CancellationToken, Task>> _exceptionHandlers = new()
    {
        { typeof(NotFoundException), HandleNotFoundExceptionAsync },
        { typeof(UnauthorizedAccessException), HandleUnauthorizedAccessExceptionAsync },
        { typeof(SubscriptionStateException), HandleSubscriptionStateExceptionAsync },
        { typeof(BillingNotConfiguredException), HandleBillingNotConfiguredExceptionAsync },
    };

    public async ValueTask<bool> TryHandleAsync(
        HttpContext httpContext,
        Exception exception,
        CancellationToken cancellationToken)
    {
        if (!_exceptionHandlers.TryGetValue(exception.GetType(), out var handler))
        {
            return false;
        }

        await handler.Invoke(httpContext, exception, cancellationToken);

        return true;
    }
}
```

A `SubscriptionStateException` is a `409`: the request was well formed and arrived at the wrong moment, and re-reading the subscription tells the caller why. A `BillingNotConfiguredException` is a `503`: the host has no payment provider, which is neither the caller's mistake nor something a retry fixes.

### Codes for the client
The AI features add a `code` extension, because one status covers several situations. A `403` can mean that an administrator turned AI off, that the person used their monthly allowance or that the organization's own key was refused, and each calls for a different message. The handler keeps a table per refusal reason:

```csharp
private static readonly Dictionary<AiRefusalReason, (int StatusCode, string Code, string Title)> AiRefusals = new()
{
    { AiRefusalReason.Unavailable, (StatusCodes.Status503ServiceUnavailable, "ai.unavailable", "AI is not available on this server.") },
    { AiRefusalReason.Disabled, (StatusCodes.Status403Forbidden, "ai.disabled", "An administrator turned built-in AI off for the organization.") },
    { AiRefusalReason.PersonalLimitReached, (StatusCodes.Status403Forbidden, "ai.personalLimitReached", "You have used your AI for this month.") },
};
```

and writes the code, plus a `resetsAt` extension when the person's allowance comes back:

```csharp
var problem = new ProblemDetails
{
    Status = refusal.StatusCode,
    Title = refusal.Title,
    Extensions = { ["code"] = refusal.Code }
};

if (resetsAt is not null)
{
    problem.Extensions["resetsAt"] = resetsAt;
}

await httpContext.Response.WriteAsJsonAsync(problem, cancellationToken);
```

None of these refusals is a `429`, on purpose: a client or a proxy reads `429` as "retry shortly", and a monthly limit is not that. The `title` is English and for developers; the `code` is the contract, and the client translates it.

### Validation as 400
Validation never throws. A write service returns a `ValidationResult<T>` whose `Errors` is a `Dictionary<string, string[]>`, the shape `ValidationProblemDetails` takes, and the controller matches on it:

```csharp
internal static class ValidationResultExtensions
{
    public static async Task<ActionResult> MatchAsync<T>(
        this ValidationResult<T> validationResult,
        Func<T, Task<ActionResult>> onSuccess,
        Func<ValidationProblemDetails, ActionResult> onFailed)
        where T : class
        => validationResult.Succeeded
            ? await onSuccess(validationResult.Value)
            : onFailed(GetValidationProblemDetails(validationResult));

    private static ValidationProblemDetails GetValidationProblemDetails(ValidationResult validationResult)
        => new(validationResult.Errors)
        {
            Status = StatusCodes.Status400BadRequest,
            Title = "Validation Failed",
            Detail = "One or more validation errors occurred."
        };
}
```

An action ends with `return await result.MatchAsync(onSuccess: ..., onFailed: BadRequest);`. Exceptions stay for what is exceptional; an invalid input is an expected outcome, and the [FluentValidation article](/blog/2023-06-03-validating-requests-with-fluentvalidation/) covers the rules themselves.

### What the Starter does not do yet
Its handlers serialize with `WriteAsJsonAsync` rather than `IProblemDetailsService`. The bodies have the problem shape, but they go out as `application/json` and carry no `traceId`; only the problems written by status code pages, the framework's own `400`s and the default `500` path get one. Moving each handler to `TryWriteAsync`, as in the generic example, adds both without changing the client. Also, the type-keyed dictionary matches the **exact** type: a subclass of `NotFoundException` would fall through to the `500` handler. An `is` check, or a walk up `BaseType`, avoids that.


## The Angular side
One functional interceptor gives every failure a default treatment:

```ts
export const QUIET_ERROR_STATUSES = new HttpContextToken<readonly number[]>(() => []);

export const errorInterceptor = (request: HttpRequest<any>, next: HttpHandlerFn): Observable<HttpEvent<any>> => {
  const toastService = inject(UiToastService);
  const router = inject(Router);
  const translocoService = inject(TranslocoService);
  const injector = inject(Injector);

  return next(request).pipe(
    catchError((error: any) => {
      if (error instanceof HttpErrorResponse && error.status === 403) {
        if (!request.context.get(QUIET_ERROR_STATUSES).includes(403)) {
          router.navigate([FORBIDDEN_PATH]);
        }

        return throwError(() => error);
      }

      if (error instanceof HttpErrorResponse && error.status === 401 && !BFF_REQUEST.test(request.url)) {
        return injector
          .get(AuthService)
          .handleUnauthorized()
          .pipe(switchMap(() => throwError(() => error)));
      }

      if (error instanceof HttpErrorResponse && error.status !== 401 && !request.context.get(QUIET_ERROR_STATUSES).includes(error.status)) {
        toastService.danger(translocoService.translate('common.error'), translocoService.translate('error.unexpected'));
      }

      return throwError(() => error);
    })
  );
};
```

The real interceptor also retries `408` and `429` up to three times. A `403` opens the forbidden page, a `401` goes to the [BFF session](/blog/2026-05-10-keep-the-access-token-out-of-the-browser-bff-angular-yarp/), and anything else shows a generic, translated toast. The server's `title` is never displayed.

A call site that knows better opts out through the `QUIET_ERROR_STATUSES` context token, and reads the `code`:

```ts
draftWorkspaceDescription(workspaceId: number, name: string): Observable<WorkspaceDescriptionDraft> {
  return this._httpClient.post<WorkspaceDescriptionDraft>(
    `/api/v1/workspaces/${workspaceId}/ai/description-drafts`,
    { name },
    { context: new HttpContext().set(QUIET_ERROR_STATUSES, AI_ACTION_QUIET_STATUSES) }
  );
}
```

```ts
const problem = error.error as { code?: AiErrorCode; resetsAt?: string } | null;
const failure: WorkspaceDescriptionDraftFailure = (problem?.code ? FAILURES[problem.code] : undefined) ?? 'failed';
```

`AiErrorCode` is a union of the server's codes, and `FAILURES` is a `Record<AiErrorCode, ...>`, so the compiler asks for a mapping of every code. An unknown code, from a newer server for instance, falls back to `'failed'`. For a `400`, forms read `error.error.errors` and keep **only the field names** to highlight the fields, because the server's messages are English whatever the reader's language.


## Costs and pitfalls
- **Codes are a contract.** Once a client maps `ai.personalLimitReached`, renaming it is a breaking change. Keep them few, namespaced and documented next to the OpenAPI spec.
- **Duplicated tables.** The codes live in a C# dictionary and a TypeScript union. Nothing checks that they agree except a review, or a test that compares them.
- **`detail` drifts.** A handler that copies `exception.Message` is safe only as long as the exception's message is ours. Wrapping a third-party exception inside one of our types brings its message with it.
- **Body-less errors from elsewhere.** A response written by a proxy or a gateway in front of the API does not go through these handlers; the client must still cope with a plain `502` without a body.


## When it is enough to do less
For an internal API with one client, `AddProblemDetails()`, `UseExceptionHandler()` and `UseStatusCodePages()` alone already give every error the RFC shape, a `traceId` and no stack trace, with no handler at all. Exception handlers become worth it when a domain exception deserves a status other than `500`. A `code` extension is only worth it when one status covers several outcomes that the client treats differently. Until then, the status code is the code.


## Conclusion
Problem details make errors boring, which is the point. `UseExceptionHandler` with chained `IExceptionHandler`s turns known exceptions into statuses and everything else into a fixed `500` that is logged, status code pages fill in the empty responses, and validation returns a `ValidationProblemDetails` without throwing. The client gets one shape, a `traceId` to quote and, where it matters, a `code` to translate. The server gives away nothing it did not write on purpose.

## References
- [RFC 9457: Problem Details for HTTP APIs (IETF)](https://www.rfc-editor.org/rfc/rfc9457) — the format, its members and extension rules.
- [RFC 7807 (IETF)](https://www.rfc-editor.org/rfc/rfc7807) — the original specification, obsoleted by RFC 9457.
- [Handle errors in ASP.NET Core APIs (Microsoft Learn)](https://learn.microsoft.com/aspnet/core/fundamentals/error-handling-api) — `AddProblemDetails`, `IProblemDetailsService` and status code pages.
- [Handle errors in ASP.NET Core (Microsoft Learn)](https://learn.microsoft.com/aspnet/core/fundamentals/error-handling) — `UseExceptionHandler`, `IExceptionHandler` and handler ordering.
- [IExceptionHandler interface (Microsoft Learn)](https://learn.microsoft.com/dotnet/api/microsoft.aspnetcore.diagnostics.iexceptionhandler) — the `TryHandleAsync` contract.
- [ValidationProblemDetails class (Microsoft Learn)](https://learn.microsoft.com/dotnet/api/microsoft.aspnetcore.mvc.validationproblemdetails) — the `errors` dictionary of a `400`.
- [Intercepting requests and responses (Angular)](https://angular.dev/guide/http/interceptors) — functional interceptors and `HttpContextToken`.
- [Blouppy Starter](https://starter.blouppy.com/) — the starter kit the examples come from.
