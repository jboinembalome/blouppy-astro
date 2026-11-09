---
templateKey: 'blog-post'
title: 'The result pattern in C#: when to return an error and when to throw'
date: 2026-12-10T09:00:00.000Z
author: Jimmy Boinembalome
authorimage: /img/jimmy.jpg
category: C#
topic: 'Architecture'
illustration: 1
categorycolor: bg-purple-100 text-purple-800
featuredpost: true
description: >-
  Learn when a C# service should return a result instead of throwing, how a validation result becomes a 400 in ASP.NET Core, and what the libraries and unions offer.
tags:
  - Development
  - C#
  - Design Patterns
  - DDD
  - ASP.NET Core
---

A service that creates a workspace can fail in several ways. The name is empty. The organization has reached its plan's limit. The database is down. A bug passes a `null` owner. If all of these throw, the controller needs a `try`/`catch` for the expected ones, and the signature says nothing about them. If none of them throws, every caller checks for failures that should never happen.

The **result pattern** draws the line between the two.


## The idea
The pattern does not come from the Gang of Four. It comes from functional programming: Haskell's `Either`, F#'s `Result`, Rust's `Result<T, E>`. Scott Wlaschin made it popular in .NET as **railway oriented programming**: each step returns a success or a failure, and a failure skips the remaining steps.

A method whose failure is part of its contract says so in its return type. The smallest useful version looks like this:

```csharp
public sealed class Result<T>
{
    private readonly T? _value;

    private Result(T? value, string? error)
    {
        _value = value;
        Error = error;
    }

    public string? Error { get; }

    public bool Succeeded => Error is null;

    public T Value => Succeeded
        ? _value!
        : throw new InvalidOperationException("No value on a failed result.");

    public static Result<T> Success(T value) => new(value, null);

    public static Result<T> Failure(string error) => new(default, error);
}
```

The constructor is private, so a result is a success or a failure, never both. Reading `Value` on a failure throws, because that is a bug in the caller, and bugs are what exceptions are for.

That gives the rule:

- **Expected failures are results**: invalid input, a missing resource, an action a business rule refuses. The caller is meant to handle them.
- **Bugs and broken invariants are exceptions**: a `null` the type forbids, a database that does not answer. No caller can fix them. They reach one handler that logs and answers 500.


## From validator to 400
[Blouppy Starter](https://starter.blouppy.com/) keeps its result types in `Blouppy.SharedKernel/Results/`. Its `ValidationResult<T>` is the type above with one change: instead of one string, it carries errors keyed by property. That is the shape FluentValidation produces and the shape `ValidationProblemDetails` expects.

The service runs the validator and returns its errors. The `Try` prefix tells the caller to expect a failure (trimmed from the real `WorkspacesService`):

```csharp
public async Task<ValidationResult<Workspace>> TryAddAsync(
    WorkspaceCreation workspaceCreation,
    CancellationToken cancellationToken = default)
{
    var result = await workspaceCreationValidator.ValidateAsync(workspaceCreation, cancellationToken);

    if (!result.IsValid)
    {
        return ValidationResult.Failure<Workspace>(result.ToDictionary());
    }

    var workspace = new Workspace(workspaceCreation.Name, workspaceCreation.Colour, ...);

    await workspacesRepository.AddAsync(workspace, cancellationToken);

    return ValidationResult.Success(workspace);
}
```

The validator holds an empty name, a name over 50 characters and a business rule: *"The organization has reached the number of workspaces its plan allows."* For the caller, they are all the same kind of failure.

The controller passes one function per outcome to a small `MatchAsync` extension, which builds the `ValidationProblemDetails` on failure:

```csharp
var result = await workspacesService.TryAddAsync(workspaceCreation, cancellationToken);

return await result.MatchAsync(
    onSuccess: async workspace =>
    {
        await unitOfWork.CommitAsync(cancellationToken);

        var dto = await workspaceDtoFactory.CreateAsync(workspace, cancellationToken);

        return CreatedAtRoute(RouteNames.Api.Workspaces.Get, new { id = dto.Id }, dto);
    },
    onFailed: BadRequest);
```

A failure becomes a 400, a success a 201. And the unit of work commits only inside `onSuccess`, so a failed validation never writes anything.

The same folder holds `SearchResult<T>` (found or not) and `DeletionResult`, with three states: `Deleted`, `NotFound` and `Refused`. Deleting an organization you do not own comes back as `Refused` and becomes a 400.


## Where it throws on purpose
The code base still throws in a few places, and each fits the rule.

**Invariants in the model.** `Workspace` checks its name with `Exceptions.ThrowIfNullOrWhiteSpace`. The validator has already refused an empty name, so if this throws, a caller skipped validation. That is a bug.

**A refusal deep under many features.** The AI gateway throws `AiRefusedException` when it will not call a model: AI disabled, paused, monthly limit reached. That is a business refusal, so it could be a result. But the gateway sits under every AI feature, and each would have to pass the refusal up unchanged. Instead, one `IExceptionHandler` maps each reason to a status code and a `code` the page understands. Where a caller must keep going, it converts: the assistant catches the exception and ends its stream cleanly.

**A missing resource during an update.** `TryUpdateAsync` throws `NotFoundException`, which the handler turns into a 404. `TryDeleteAsync` returns `DeletionResult.NotFound()` instead. Both are fine. Mixing styles is not a problem as long as each one has a reason.


## Libraries and unions
We do not have to write our own type. [ErrorOr](https://github.com/error-or/error-or), [FluentResults](https://github.com/altmann/FluentResults), [Ardalis.Result](https://github.com/ardalis/Result) and [OneOf](https://github.com/mcintyre321/OneOf) are the common ones. A small in-house type is often enough: it has exactly the failures the app needs and adds no dependency to the domain. A library pays off when we want its combinators or an exhaustive `Match`.

What all of them imitate is a **discriminated union**: a type that is exactly one of a closed set of cases. C# does not have one yet. A proposal is being designed in the [csharplang repository](https://github.com/dotnet/csharplang), and its syntax may still change. What it would bring is exhaustiveness: a `switch` that forgets a case would be reported. Today, `DeletionResult` is an enum, so its `MatchAsync` needs an arm that throws `UnreachableException`.


## The traps
**An ignored result raises no warning.** `await workspacesService.TryAddAsync(...)` alone on a line compiles, and the failure disappears. The `Try` prefix and code review help; the compiler does not.

**Results inside results.** A `ValidationResult<SearchResult<Workspace>>` means two layers have not agreed on who handles what. Pick one type per boundary.

**Long `Map`/`Bind` chains.** They read well in F#. In C#, with `async` in the middle, they hurt readability and stack traces. The Starter uses early returns, which anyone reads at a glance.

**Performance is rarely the reason.** Throwing costs more than returning an object, but for a request that fails validation now and then, the difference is invisible next to a database round trip.


## References
- [Railway Oriented Programming](https://fsharpforfunandprofit.com/rop/) — Scott Wlaschin's talk that made the pattern popular.
- [Best practices for exceptions](https://learn.microsoft.com/dotnet/standard/exceptions/best-practices-for-exceptions) — Microsoft Learn: when to throw, and when not to.
- [Handle errors in ASP.NET Core](https://learn.microsoft.com/aspnet/core/fundamentals/error-handling) — Microsoft Learn: `IExceptionHandler` and problem details.
- [Validating requests with FluentValidation](/blog/2023-06-03-validating-requests-with-fluentvalidation/) — the validators that produce the errors.
