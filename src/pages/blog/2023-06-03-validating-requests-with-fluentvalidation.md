---
templateKey: 'blog-post'
title: 'Validating requests with FluentValidation'
date: 2023-06-03T18:24:10.000Z
updated: 2026-11-07T09:00:00.000Z
author: Jimmy Boinembalome
authorimage: /img/jimmy.jpg
category: C#
topic: 'C# & .NET'
illustration: 1
categorycolor: bg-purple-100 text-purple-800
featuredpost: true
featuredimage: /img/validating-requests-with-fluentvalidation.jpg
description: >-
  Learn how to validate ASP.NET Core requests with FluentValidation 12, in a controller and in a Minimal API endpoint filter, and return standard problem details.
tags:
  - Development
  - C#
  - ASP.NET Core
  - FluentValidation
---

> **Updated November 2026:** rewritten for .NET 10 and FluentValidation 12. The deprecated `FluentValidation.AspNetCore` package is gone, the controller now returns a proper `ValidationProblem`, and there is a new section for Minimal APIs.

Validation makes sure that the data a client sends meets your requirements before you act on it. ASP.NET Core offers several ways to validate requests, and [FluentValidation](https://docs.fluentvalidation.net/en/latest/) is a popular one: it defines validation rules with a fluent, strongly typed API.

In this article, we use **FluentValidation** to validate incoming requests in an **ASP.NET Core Web API**, both in a controller and in a Minimal API.

## Prerequisites
- The [.NET 10 SDK](https://dotnet.microsoft.com/download/dotnet/10.0).
- An editor, for example [Visual Studio Code](https://code.visualstudio.com/) with the [C# Dev Kit extension](https://marketplace.visualstudio.com/items?itemName=ms-dotnettools.csdevkit).

## What is FluentValidation?
FluentValidation is an open-source validation library for .NET. You describe the rules of a type in a validator class, in a readable, declarative style, and you can unit test that class on its own. The library does not depend on ASP.NET Core, but it integrates well with it.

## Create a new project
1. Create a folder named **IntroductionToFluentValidation** and open a terminal in it.
2. Create an ASP.NET Core Web API with controllers ([`dotnet new webapi`](https://learn.microsoft.com/dotnet/core/tools/dotnet-new-sdk-templates)):
```powershell
dotnet new webapi --use-controllers --framework net10.0
```
3. Add the FluentValidation packages:
```powershell
dotnet add package FluentValidation
dotnet add package FluentValidation.DependencyInjectionExtensions
```

[`FluentValidation`](https://www.nuget.org/packages/FluentValidation) holds the validators, and `FluentValidation.DependencyInjectionExtensions` provides [`AddValidatorsFromAssembly()`](https://docs.fluentvalidation.net/en/latest/di.html) to register them.

> **_Note:_** Older tutorials, including the first version of this one, use [`FluentValidation.AspNetCore`](https://www.nuget.org/packages/FluentValidation.AspNetCore). It plugs FluentValidation into the MVC validation pipeline to validate requests automatically. The package is now deprecated on NuGet, and the [FluentValidation documentation](https://docs.fluentvalidation.net/en/latest/aspnet.html) no longer recommends that approach for new projects: it only works with MVC, it cannot run asynchronous rules, and it is hard to debug. We do not need it, because we call the validator ourselves.

## Create a Validator
Each request type gets its own validator. Our endpoint creates a user and receives this request:

```csharp
namespace IntroductionToFluentValidation.Requests;

public sealed record CreateUserRequest(string FirstName, string LastName, string Email);
```

The validator inherits from `AbstractValidator<T>`:

```csharp
using FluentValidation;
using IntroductionToFluentValidation.Requests;

namespace IntroductionToFluentValidation.Validators;

public sealed class CreateUserRequestValidator : AbstractValidator<CreateUserRequest>
{
    public CreateUserRequestValidator()
    {
        RuleFor(request => request.FirstName)
            .NotEmpty().WithMessage("First name is required.")
            .MaximumLength(50).WithMessage("First name cannot exceed 50 characters.");

        RuleFor(request => request.LastName)
            .NotEmpty().WithMessage("Last name is required.")
            .MaximumLength(50).WithMessage("Last name cannot exceed 50 characters.");

        RuleFor(request => request.Email)
            .NotEmpty().WithMessage("Email is required.")
            .EmailAddress().WithMessage("Invalid email address.");
    }
}
```

`RuleFor` selects the property to validate, and the [built-in validators](https://docs.fluentvalidation.net/en/latest/built-in-validators.html) (`NotEmpty`, `MaximumLength`, `EmailAddress`...) chain on it.

### Wiring Up FluentValidation
Register the validators and configure the controllers in **Program.cs**:

```csharp
using FluentValidation;
using IntroductionToFluentValidation.Endpoints;

var builder = WebApplication.CreateBuilder(args);

builder.Services.AddValidatorsFromAssembly(typeof(Program).Assembly);

// FluentValidation is the only validation in this sample: do not let MVC reject a missing
// non-nullable property with its own message before the validator runs.
builder.Services.AddControllers(options =>
    options.SuppressImplicitRequiredAttributeForNonNullableReferenceTypes = true);
builder.Services.AddProblemDetails();
builder.Services.AddOpenApi();

var app = builder.Build();

app.UseExceptionHandler();
app.UseStatusCodePages();
```

- `AddValidatorsFromAssembly()` registers every validator of the assembly that contains `Program`, so you do not register them one by one. They are scoped by default.
- By default, `[ApiController]` [treats every non-nullable property as required](https://learn.microsoft.com/aspnet/core/mvc/models/validation) and answers `"The LastName field is required."` before the action runs, so FluentValidation never sees the request. Setting [`SuppressImplicitRequiredAttributeForNonNullableReferenceTypes`](https://learn.microsoft.com/dotnet/api/microsoft.aspnetcore.mvc.mvcoptions.suppressimplicitrequiredattributefornonnullablereferencetypes) to `true` leaves the decision, and the messages, to our validator.
- [`AddProblemDetails()`](https://learn.microsoft.com/aspnet/core/fundamentals/error-handling-api), with the exception handler and status code pages, makes every error, including an unhandled exception, answer with a problem details body.

### Applying Validation in a Controller
Inject `IValidator<CreateUserRequest>` through the controller's primary constructor and call it in the action:

```csharp
[ApiController]
[Route("api/[controller]")]
public sealed class UsersController(IValidator<CreateUserRequest> validator) : ControllerBase
{
    [HttpPost]
    [ProducesResponseType(StatusCodes.Status200OK)]
    [ProducesResponseType<ValidationProblemDetails>(StatusCodes.Status400BadRequest, "application/problem+json")]
    public async Task<IActionResult> CreateUser(CreateUserRequest request, CancellationToken cancellationToken)
    {
        var validationResult = await validator.ValidateAsync(request, cancellationToken);

        if (!validationResult.IsValid)
        {
            // ValidationProblem() then formats the errors like ASP.NET Core's own validation errors.
            foreach (var error in validationResult.Errors)
            {
                ModelState.AddModelError(error.PropertyName, error.ErrorMessage);
            }

            return ValidationProblem(ModelState);
        }

        // Process the valid request...
        return Ok();
    }
}
```

[`ValidateAsync`](https://docs.fluentvalidation.net/en/latest/async.html) runs the rules and receives the request's `CancellationToken`. If validation fails, the action copies each error into `ModelState` and returns [`ValidationProblem(ModelState)`](https://learn.microsoft.com/dotnet/api/microsoft.aspnetcore.mvc.controllerbase.validationproblem). ASP.NET Core turns it into a **400 Bad Request** whose body is a standard `ValidationProblemDetails` ([RFC 9457](https://www.rfc-editor.org/rfc/rfc9457)), with a `type` pointing to [RFC 9110 §15.5.1](https://www.rfc-editor.org/rfc/rfc9110#section-15.5.1) and a `traceId` to find the request in the logs. The `[ProducesResponseType]` attributes describe both responses in the [OpenAPI document](https://learn.microsoft.com/aspnet/core/fundamentals/openapi/aspnetcore-openapi).

> **_Note:_** The first version of this article returned `BadRequest(new BadRequestObjectResult(details))`. That wraps a result inside another result, so the client received the details nested under a `"value"` property instead of a problem details body.

### Testing the endpoint
Without a last name, FluentValidation reports that the last name is required:

```bash
curl -i -X POST http://localhost:5098/api/users \
  -H 'Content-Type: application/json' \
  -d '{"firstName":"Jimmy","lastName":"","email":"jimmy@example.com"}'
```

```
HTTP/1.1 400 Bad Request
Content-Type: application/problem+json; charset=utf-8

{"type":"https://tools.ietf.org/html/rfc9110#section-15.5.1","title":"One or more validation errors occurred.","status":400,"errors":{"LastName":["Last name is required."]},"traceId":"00-c4e80fa53db5e02577c509a8a8f20c94-b560feaaf2dd5506-00"}
```

Every failing rule is reported at once. Here the last name is missing and the email is invalid (`"email":"not-an-email"`):

```
HTTP/1.1 400 Bad Request
Content-Type: application/problem+json; charset=utf-8

{"type":"https://tools.ietf.org/html/rfc9110#section-15.5.1","title":"One or more validation errors occurred.","status":400,"errors":{"Email":["Invalid email address."],"LastName":["Last name is required."]},"traceId":"00-1eaef520adaef4b6d172a68b0993cd94-5f04268b1a182a3f-00"}
```

## Validating a Minimal API
Minimal APIs have no `ModelState` and no action filters, but they have [endpoint filters](https://learn.microsoft.com/aspnet/core/fundamentals/minimal-apis/min-api-filters). A generic filter can validate the request before the handler runs, for every endpoint that needs it:

```csharp
using FluentValidation;

namespace IntroductionToFluentValidation.Filters;

// Validates the first argument of type T before the endpoint runs.
public sealed class ValidationFilter<T>(IValidator<T> validator) : IEndpointFilter
{
    public async ValueTask<object?> InvokeAsync(EndpointFilterInvocationContext context, EndpointFilterDelegate next)
    {
        var request = context.Arguments.OfType<T>().FirstOrDefault();
        if (request is null)
        {
            return TypedResults.BadRequest();
        }

        var validationResult = await validator.ValidateAsync(request, context.HttpContext.RequestAborted);
        if (!validationResult.IsValid)
        {
            return TypedResults.ValidationProblem(validationResult.ToDictionary());
        }

        return await next(context);
    }
}
```

`ToDictionary()` groups the errors by property name, which is the shape [`TypedResults.ValidationProblem()`](https://learn.microsoft.com/aspnet/core/fundamentals/minimal-apis/responses) expects. Attach the filter to the endpoint, and declare the response it can produce for OpenAPI:

```csharp
app.MapPost("/api/minimal/users", (CreateUserRequest request) =>
    {
        // Process the valid request...
        return TypedResults.Ok();
    })
    .AddEndpointFilter<ValidationFilter<CreateUserRequest>>()
    .ProducesValidationProblem();
```

The handler only deals with valid requests, and the error has the same shape as the controller's:

```
HTTP/1.1 400 Bad Request
Content-Type: application/problem+json

{"type":"https://tools.ietf.org/html/rfc9110#section-15.5.1","title":"One or more validation errors occurred.","status":400,"errors":{"LastName":["Last name is required."],"Email":["Invalid email address."]},"traceId":"00-905b98e0fbbff377012acff69135e3d4-fe95868c36535190-00"}
```

> **_Note:_** Since .NET 10, [Minimal APIs can validate requests on their own](https://learn.microsoft.com/aspnet/core/fundamentals/minimal-apis): call `builder.Services.AddValidation()` and decorate the request with Data Annotations (`[Required]`, `[EmailAddress]`...). It suits simple rules. FluentValidation is the better fit for richer ones: conditions, rules that depend on other properties, asynchronous checks, or validators you want to unit test on their own.

## Conclusion
FluentValidation keeps validation rules in dedicated, testable classes. With a few lines of setup, the same validator serves a controller and a Minimal API, and both return validation errors in the standard problem details format.

Source code of the article: [GitHub source code](https://github.com/jboinembalome/IntroductionToFluentValidation)

## References
- [Handle errors in ASP.NET Core APIs](https://learn.microsoft.com/aspnet/core/fundamentals/error-handling-api) — `AddProblemDetails`, `ValidationProblem` and the problem details format.
- [Model validation in ASP.NET Core](https://learn.microsoft.com/aspnet/core/mvc/models/validation) — automatic 400 responses and non-nullable reference types.
- [MvcOptions.SuppressImplicitRequiredAttributeForNonNullableReferenceTypes](https://learn.microsoft.com/dotnet/api/microsoft.aspnetcore.mvc.mvcoptions.suppressimplicitrequiredattributefornonnullablereferencetypes) — the option that turns the implicit check off.
- [Filters in Minimal API apps](https://learn.microsoft.com/aspnet/core/fundamentals/minimal-apis/min-api-filters) — `IEndpointFilter` and `AddEndpointFilter`.
- [Create responses in Minimal API applications](https://learn.microsoft.com/aspnet/core/fundamentals/minimal-apis/responses) — `TypedResults` and response metadata.
- [Minimal APIs quick reference](https://learn.microsoft.com/aspnet/core/fundamentals/minimal-apis) — includes the built-in validation of .NET 10.
- [Generate OpenAPI documents](https://learn.microsoft.com/aspnet/core/fundamentals/openapi/aspnetcore-openapi) — the built-in `Microsoft.AspNetCore.OpenApi` package.
- [RFC 9457: Problem Details for HTTP APIs](https://www.rfc-editor.org/rfc/rfc9457) — the format of the error bodies.
- [FluentValidation documentation](https://docs.fluentvalidation.net/en/latest/) — the library's official documentation.
- [FluentValidation: ASP.NET Core](https://docs.fluentvalidation.net/en/latest/aspnet.html) — manual validation and why automatic validation is no longer recommended.
- [FluentValidation: Dependency injection](https://docs.fluentvalidation.net/en/latest/di.html) — `AddValidatorsFromAssembly` and validator lifetimes.
- [FluentValidation: Built-in validators](https://docs.fluentvalidation.net/en/latest/built-in-validators.html) — `NotEmpty`, `MaximumLength`, `EmailAddress` and the others.
- [FluentValidation: Asynchronous validation](https://docs.fluentvalidation.net/en/latest/async.html) — `ValidateAsync` and async rules.
