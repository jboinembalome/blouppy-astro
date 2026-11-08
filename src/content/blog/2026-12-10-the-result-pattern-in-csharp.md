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

A service that creates a workspace can fail in several ways. The name is empty, the organization has reached its plan's limit, the database is down, or a bug passes a `null` owner. If every one of these throws, the controller needs a `try`/`catch` for the expected ones, and the method signature says nothing about them. If none of them throws, every caller has to check for failures that should never happen.

In this article, we will look at the **result pattern**: what it is and where it comes from, a minimal version, the one [Blouppy Starter](https://starter.blouppy.com/) uses from service to HTTP response, the places where the same code base still throws on purpose, the existing libraries, what the unions being designed for C# would change, and the pitfalls.


## Where the pattern comes from
The result pattern has no entry in the Gang of Four catalogue, in Evans' *Domain-Driven Design* or in Fowler's *Patterns of Enterprise Application Architecture*. Its source is functional programming: Haskell's `Either`, F#'s `Result<'T, 'TError>`, Rust's `Result<T, E>`. Scott Wlaschin popularised it for .NET developers as **railway oriented programming**: each step returns either a success or a failure, and a failure skips the remaining steps like a train switched onto a second track.

The idea is simple. A method whose failure is part of its contract says so in its return type, and the caller cannot get the value without passing the check.


## A minimal result
Here is the smallest useful version:

```csharp
namespace Results;

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

Two details matter. The constructor is private, so a result is either a success or a failure, never both. And reading `Value` on a failure throws: that is a bug in the caller, and bugs are what exceptions are for.

The rule we will use for the rest of the article follows from it:

- **Expected failures are results**: invalid input, a resource that does not exist, an action a business rule refuses. The caller is supposed to handle them, and the signature should say so.
- **Bugs and broken invariants are exceptions**: a `null` where the type forbids one, a value read from a failed result, a database that does not answer. No caller can do anything useful with them, except let them reach one handler that logs and answers 500.


## The real example: `ValidationResult<T>`
Blouppy Starter keeps its result types in `Blouppy.SharedKernel/Results/`, so that both the domains and the Web can use them. `ValidationResult<T>` carries errors keyed by property, which is the shape FluentValidation produces and the shape ASP.NET Core's `ValidationProblemDetails` expects:

```csharp
namespace Blouppy.SharedKernel.Results;

public class ValidationResult
{
    protected ValidationResult(bool succeeded, IDictionary<string, string[]> errors)
    {
        Succeeded = succeeded;
        Errors = errors;
    }

    public bool Succeeded { get; }
    public bool Failed => !Succeeded;
    public IDictionary<string, string[]> Errors { get; }

    public static ValidationResult<T> Success<T>(T value)
        => new(value, true, new Dictionary<string, string[]>());

    public static ValidationResult<T> Failure<T>(IDictionary<string, string[]> errors)
        => new(default, false, errors);
}

public sealed class ValidationResult<T>(T? value, bool succeeded, IDictionary<string, string[]> errors)
    : ValidationResult(succeeded, errors)
{
    [NotNull]
    public T Value => Succeeded
        ? value!
        : throw new InvalidOperationException($"{nameof(Value)} cannot be accessed when validation has failed.");
}
```

`WorkspacesService.TryAddAsync` runs the validator and returns its errors as a failure. The `Try` prefix in the name tells the caller to expect one:

```csharp
internal sealed class WorkspacesService(
    IWorkspacesRepository workspacesRepository,
    IValidator<WorkspaceCreation> workspaceCreationValidator,
    ICurrentUserService currentUserService) : IWorkspacesService
{
    public async Task<ValidationResult<Workspace>> TryAddAsync(
        WorkspaceCreation workspaceCreation,
        CancellationToken cancellationToken = default)
    {
        workspaceCreation = workspaceCreation with { OwnerId = currentUserService.UserId };

        var result = await workspaceCreationValidator.ValidateAsync(workspaceCreation, cancellationToken);

        if (!result.IsValid)
        {
            return ValidationResult.Failure<Workspace>(result.ToDictionary());
        }

        var workspace = new Workspace(
            name: workspaceCreation.Name,
            colour: workspaceCreation.Colour,
            ownerId: workspaceCreation.OwnerId,
            organizationId: workspaceCreation.OrganizationId);

        await workspacesRepository.AddAsync(workspace, cancellationToken);

        workspace.MarkAsCreated();

        return ValidationResult.Success(workspace);
    }
}
```

The validator holds an empty name, a name over 50 characters, an unknown colour, and a business rule: an organization that has reached the number of workspaces its plan allows gets *"The organization has reached the number of workspaces its plan allows."*. For the caller, all of them are the same kind of failure, with a message per property. The [FluentValidation article](/blog/2023-06-03-validating-requests-with-fluentvalidation/) covers the validator itself.

In `Blouppy.Web`, one extension method turns the result into a response:

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

And the controller passes one function per outcome:

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

A failure becomes a 400 with a `ValidationProblemDetails` body, a success a 201. There is a second benefit: the unit of work commits only inside `onSuccess`, so a failed validation can never write anything.

The same folder holds two siblings. `SearchResult<T>` is a found-or-not-found lookup, and `DeletionResult` has three states, `Deleted`, `NotFound` and `Refused`. `OrganizationsService` uses the third for a business rule: *"Only the owner can delete the organization."* comes back as `Refused`, and the controller answers 400; `NotFound` becomes a 404. `DeletionResultExtensions.MatchAsync` switches over the status and throws `UnreachableException` for a status it does not handle, because that is a bug.


## Where the code base throws on purpose
The same code base throws in three kinds of places, and each one fits the rule.

**Invariants in the model.** `Workspace` checks its own state with the helpers of `Blouppy.SharedKernel/Exceptions`:

```csharp
public string Name { get; private set; } = Exceptions.ThrowIfNullOrWhiteSpace(name);
public OrganizationId OrganizationId { get; private set; } = Exceptions.ThrowIfNullOrNegativeOrZero(organizationId);
```

The validator has already refused an empty name, so if this line throws, a caller skipped the validation. Turning that into a result would ask every caller to handle a case that only a bug produces.

**Refusals deep under many features.** `AiGateway` throws `AiRefusedException` with a reason (`Disabled`, `Paused`, `PersonalLimitReached`…) when it will not call a model. This is a business refusal, so by our rule it could be a result. The gateway sits under every AI feature, though, and each feature would have to pass the refusal up unchanged. Instead, `GlobalExceptionHandler`, an `IExceptionHandler`, maps each reason to a status code and a `code` the page understands:

```csharp
private static readonly Dictionary<AiRefusalReason, (int StatusCode, string Code, string Title)> AiRefusals = new()
{
    { AiRefusalReason.Disabled, (StatusCodes.Status403Forbidden, "ai.disabled", "An administrator turned built-in AI off for the organization.") },
    { AiRefusalReason.PersonalLimitReached, (StatusCodes.Status403Forbidden, "ai.personalLimitReached", "You have used your AI for this month.") },
};
```

The exception is still part of the contract: `IAiGateway` documents it with `<exception cref="AiRefusedException">`. And where a caller has to keep going, it converts. The assistant's turn service catches `AiRefusedException` and ends the turn with a `Refused` stop reason, so the stream it is writing ends cleanly. Exceptions travel far; results are easier to handle at one precise place.

**A missing resource during an update.** `TryUpdateAsync` loads the workspace with `.OrThrowResourceNotFoundAsync(id)`, which throws `NotFoundException`, and the global handler answers 404. `TryDeleteAsync` returns `DeletionResult.NotFound()` instead. Both end in a 404. The result version shows the case in the signature; the exception version keeps `ValidationResult<T>` to one kind of failure. The code base is not purist, and a mix like this is fine as long as each style is used for a reason.

Everything else, from a broken database connection to a `NullReferenceException`, reaches `UnhandledExceptionHandler`, which logs it and answers a plain 500.


## The existing libraries
We do not have to write our own type. The most common packages on NuGet, each in one or two lines:

- [FluentResults](https://github.com/altmann/FluentResults): `Result` and `Result<T>` carrying a list of error and success objects, which can hold metadata and causes.
- [ErrorOr](https://github.com/error-or/error-or): `ErrorOr<T>`, a value or a list of `Error`s with a type (validation, not found, conflict…), with `Match`, `Then` and implicit conversions from both sides.
- [OneOf](https://github.com/mcintyre321/OneOf): `OneOf<T0, …, Tn>`, a general union of any types, with a `Match` that takes one function per case, so a new case breaks every call site at compile time.
- [Ardalis.Result](https://github.com/ardalis/Result): a `Result<T>` with a status (`Ok`, `NotFound`, `Invalid`, `Forbidden`…), and a companion package that maps it to ASP.NET Core responses.
- [CSharpFunctionalExtensions](https://github.com/vkhorikov/CSharpFunctionalExtensions): `Result`, `Result<T, E>` and `Maybe<T>`, with `Map`, `Bind`, `Tap` and `Ensure` for railway-style chains.
- [LanguageExt](https://github.com/louthy/language-ext): a full functional base library, with `Either`, `Option`, `Fin` and much more. The most powerful, and the furthest from idiomatic C#.

A small in-house type, like Blouppy's, is often enough: it has exactly the failures the application needs, it maps to `ValidationProblemDetails` without an adapter, and it adds no dependency to the domain projects. A library pays off when we want its combinators or its exhaustive `Match`.


## Unions in C#
What every one of these types imitates is a **discriminated union**: a type that is exactly one of a closed set of cases. F# has them. C# does not, yet.

The C# language design team has a proposal for unions in the [csharplang repository](https://github.com/dotnet/csharplang), with working-group notes on the design. At the time of writing it is still being designed, and we will not guess which version ships it. Purely as an illustration, the direction looks like this (**the syntax may change**):

```csharp
// Illustrative only: proposed syntax, may change before it ships.
public record NotFound(string Resource);
public record Invalid(IDictionary<string, string[]> Errors);

public union CreationOutcome(Workspace, Invalid, NotFound);
```

What a union would change is **exhaustiveness**. The compiler knows the closed set of cases, so a `switch` that forgets one is reported, and adding a case shows every place to update. Today we have workarounds. An abstract record hierarchy with a `switch` expression reads well, but the hierarchy is open: the compiler warns about a non-exhaustive switch (CS8509) and asks for a discard, and once we add the `_` arm, a new case falls into it silently. `OneOf` gives a compile-time check through its `Match`, at the price of a generic type that names its cases by position (`T0`, `T1`), not by meaning. Blouppy's `DeletionResult` is the enum version of the same idea, which is why its `MatchAsync` needs an `UnreachableException` arm.


## Pitfalls and costs
**An ignored result raises no warning.** `await workspacesService.TryAddAsync(...)` on its own line compiles, and the failure disappears. An exception would at least have surfaced. Naming (`Try…`), code review and an analyzer such as JetBrains' `[MustUseReturnValue]` help, but nothing in the C# compiler enforces it.

**Results inside results.** A `ValidationResult<SearchResult<Workspace>>` or a `Task<Result<Result<T>>>` means two layers have not agreed on who handles what. Pick one type per boundary and flatten at the edge.

**Long `Map`/`Bind` chains.** In F#, a pipeline of `Result` functions reads naturally. In C#, a chain of lambdas with `async` in the middle hurts readability and stack traces:

```csharp
// Railway style: correct, but hard to step through.
return await Validate(creation)
    .Bind(CheckQuotaAsync)
    .Map(CreateWorkspace)
    .Tap(SaveAsync);
```

The Starter uses early returns, an `if (!result.IsValid) return Failure(...)`, which any C# developer reads at a glance. A chain earns its place when there are many steps that each can fail the same way.

**Performance.** Throwing captures a stack trace and unwinds frames, so it costs far more than returning an object, and .NET's own guidance is to avoid exceptions for common conditions. For a request that fails validation once in a while, the difference is invisible next to a database round trip. Exceptions matter on hot paths that fail often. Measure before rewriting anything for speed; the [BenchmarkDotNet article](/blog/2022-10-22-introduction-to-benchmarkdotnet/) shows how.

**When not to use it.** A private method with one caller can throw or return `bool`. An `if` around `TryParse` needs no result type. And a failure that no caller can handle (a broken invariant, a missing configuration at startup) only becomes noise once it is wrapped in a result.


## Conclusion
The result pattern puts expected failures in the signature: invalid input, a missing resource, a business refusal. Exceptions stay for bugs and broken invariants, and for the rare refusal that has to cross many layers to one handler. Blouppy Starter shows both: `ValidationResult<T>` from the validator to a `ValidationProblemDetails`, a commit only on success, and `GlobalExceptionHandler` for what is thrown on purpose. Start with a small type of our own, reach for a library when we need its combinators, and keep an eye on unions, which would give C# the exhaustive check every one of these types imitates.


## References
- [Railway Oriented Programming (F# for Fun and Profit)](https://fsharpforfunandprofit.com/rop/) — Scott Wlaschin's talk and article that popularised the pattern.
- [Best practices for exceptions (Microsoft Learn)](https://learn.microsoft.com/dotnet/standard/exceptions/best-practices-for-exceptions) — when to throw, and how to avoid exceptions for common conditions.
- [Handle errors in ASP.NET Core (Microsoft Learn)](https://learn.microsoft.com/aspnet/core/fundamentals/error-handling) — `IExceptionHandler` and problem details.
- [C# language design (GitHub)](https://github.com/dotnet/csharplang) — where the unions proposal and its working-group notes are published.
- [FluentResults](https://github.com/altmann/FluentResults), [ErrorOr](https://github.com/error-or/error-or), [OneOf](https://github.com/mcintyre321/OneOf), [Ardalis.Result](https://github.com/ardalis/Result), [CSharpFunctionalExtensions](https://github.com/vkhorikov/CSharpFunctionalExtensions), [LanguageExt](https://github.com/louthy/language-ext) — the libraries compared above.
- [Validating requests with FluentValidation](/blog/2023-06-03-validating-requests-with-fluentvalidation/) — the validators that produce the errors.
- [An AI gateway for your SaaS in ASP.NET Core](/blog/2026-10-19-an-ai-gateway-for-your-saas/) — the gateway behind `AiRefusedException`.
