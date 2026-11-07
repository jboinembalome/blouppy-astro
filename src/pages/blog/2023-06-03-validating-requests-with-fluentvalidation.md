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
  Learn how to effectively integrate and utilize FluentValidation for request validation in ASP.NET Core Web API.
tags:
  - Development
  - C#
  - ASP.NET Core
  - FluentValidation
---

> **Updated November 2026:** rewritten for .NET 10 and FluentValidation 12. The deprecated `FluentValidation.AspNetCore` package is gone, the controller now returns a proper `ValidationProblem`, and there is a new section for Minimal APIs.

Validation is a critical aspect of any web application, ensuring that the data received from clients is accurate and meets the specified requirements. In **ASP.NET Core Web API**, there are several ways to perform request validation, and one popular library for this purpose is **FluentValidation**. FluentValidation provides a fluent and expressive way to define validation rules and apply them to your API endpoints. 

In this article, we will explore how to use **FluentValidation** in **ASP.NET Core Web API** to validate incoming requests effectively, both in a controller and in a Minimal API.


## Prerequisites
Before to start you will need:
- [Visual Studio Code](https://code.visualstudio.com/) with the [C# Dev Kit extension](https://marketplace.visualstudio.com/items?itemName=ms-dotnettools.csdevkit).
- The [.NET 10 SDK](https://dotnet.microsoft.com/en-us/download/dotnet/10.0).

> **_Note:_**  Of course, you can develop with your favourite IDE as well. 🙂


## What is FluentValidation?
FluentValidation is an open-source validation library for .NET applications, designed to provide a fluent and intuitive approach to defining and executing validation rules. It offers a declarative syntax that allows developers to express validation logic in a concise and readable manner. FluentValidation is not specific to ASP.NET Core and can be seamlessly integrated into a Web API project.

Now we will install **FluentValidation**.


## Create a new project
1. Create a new folder named **IntroductionToFluentValidation**.
2. Open the created folder with **Visual Studio Code**.
3. Open a new **Terminal** in **Visual Studio Code**.
4. In the **Terminal**, run the following command to create a new **ASP.NET Core Web API** with controllers on **.NET 10**:
```powershell
dotnet new webapi --use-controllers --framework net10.0
```
5. Install the **FluentValidation** NuGet packages with the following commands:
```powershell
dotnet add package FluentValidation
dotnet add package FluentValidation.DependencyInjectionExtensions
```

`FluentValidation` holds the validators, and `FluentValidation.DependencyInjectionExtensions` brings `AddValidatorsFromAssembly()` to register them.

> **_Note:_** You may have seen `FluentValidation.AspNetCore` in older tutorials (including the first version of this one 😅). It plugs FluentValidation into the MVC validation pipeline to validate requests automatically. It is now marked as deprecated (legacy) on NuGet, and the FluentValidation documentation no longer recommends that approach for new projects: it is MVC-only, synchronous, and hard to debug. We do not need it here, because we call the validator ourselves.


## Create a Validator
To apply validation rules to incoming requests, we need to create a validator class for each request model. Let's assume we have an API endpoint that is responsible for creating a new user. Here is the request it receives:

```csharp
namespace IntroductionToFluentValidation.Requests;

public sealed record CreateUserRequest(string FirstName, string LastName, string Email);
```

Below is an example that demonstrates how to create a validator specifically for the user creation request:

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

In the code above, we define validation rules for the `CreateUserRequest` model. The `RuleFor` method allows us to specify the property to validate and chain various validation rules.


### Wiring Up FluentValidation
To enable FluentValidation in our project, we need to add the necessary configuration in the **Program.cs** file:

```csharp
using FluentValidation;

var builder = WebApplication.CreateBuilder(args);

// Add services to the container.
builder.Services.AddValidatorsFromAssembly(typeof(Program).Assembly);

// FluentValidation is the only validation in this sample: do not let MVC reject a missing
// non-nullable property with its own message before the validator runs.
builder.Services.AddControllers(options =>
    options.SuppressImplicitRequiredAttributeForNonNullableReferenceTypes = true);
```

With `AddValidatorsFromAssembly()`, all the validators defined in the assembly that contains `Program` will be automatically registered, eliminating the need to manually register each validator. This approach ensures that all validators are available for request validation within our project.

> **_Note:_** By default, `[ApiController]` treats every non-nullable property as required and answers `"The LastName field is required."` before our action runs, so FluentValidation never sees the request. Setting `SuppressImplicitRequiredAttributeForNonNullableReferenceTypes` to `true` leaves the decision to our validator, with our own messages.


### Applying Validation in Controller
Once we have set up FluentValidation, we can easily apply validation rules to our API endpoint:

```csharp
[ApiController]
[Route("api/[controller]")]
public class UsersController(IValidator<CreateUserRequest> validator) : ControllerBase
{
```

To incorporate validation, we inject an `IValidator<CreateUserRequest>` through the controller's primary constructor. The `CreateUserRequest` represents the model or DTO (Data Transfer Object) that we want to validate.

```csharp
    [HttpPost]
    public async Task<IActionResult> CreateUser(CreateUserRequest request, CancellationToken cancellationToken)
    {
        // Validate the request using the injected validator asynchronously
        var validationResult = await validator.ValidateAsync(request, cancellationToken);

        // Check if validation fails
        if (!validationResult.IsValid)
        {
            // Copy the errors into the ModelState, so that ValidationProblem() formats them
            // the same way as ASP.NET Core's own validation errors (type, title, status, traceId)
            foreach (var error in validationResult.Errors)
            {
                ModelState.AddModelError(error.PropertyName, error.ErrorMessage);
            }

            // Return a 400 Bad Request response with a ValidationProblemDetails body
            return ValidationProblem(ModelState);
        }

        // Process the valid request...
        return Ok();
    }
}
```

Within the CreateUser action method, we invoke the asynchronous `ValidateAsync` method on the injected `validator` to validate the incoming `CreateUserRequest`. This validation process checks whether the request data conforms to the defined validation rules.

If the validation fails, we copy each error into the `ModelState`, then return `ValidationProblem(ModelState)`. ASP.NET Core turns it into a **400 Bad Request** whose body is a standard `ValidationProblemDetails` ([RFC 9457](https://www.rfc-editor.org/rfc/rfc9457)), with the `type` pointing to [RFC 9110 §15.5.1](https://www.rfc-editor.org/rfc/rfc9110#section-15.5.1) and a `traceId` to find the request in the logs. 🙂

> **_Note:_** The first version of this article returned `BadRequest(new BadRequestObjectResult(details))`. That wraps a result inside another result, so the client received the details nested under a `"value"` property instead of a problem details body. `ValidationProblem(...)` is the right tool.


### Testing the endpoint
If we attempt to execute the request without providing a last name, FluentValidation will indicate that the last name is required:

```bash
curl -i -X POST http://localhost:5098/api/users \
  -H 'Content-Type: application/json' \
  -d '{"firstName":"Jimmy","lastName":"","email":"jimmy@example.com"}'
```

```
HTTP/1.1 400 Bad Request
Content-Type: application/problem+json; charset=utf-8

{"type":"https://tools.ietf.org/html/rfc9110#section-15.5.1","title":"One or more validation errors occurred.","status":400,"errors":{"LastName":["Last name is required."]},"traceId":"00-b7a75aadf62a3411cd98c69b3db707b6-858d9018c956f3ce-00"}
```

And every failing rule is reported at once. Here the last name is missing and the email is wrong:

```
HTTP/1.1 400 Bad Request
Content-Type: application/problem+json; charset=utf-8

{"type":"https://tools.ietf.org/html/rfc9110#section-15.5.1","title":"One or more validation errors occurred.","status":400,"errors":{"Email":["Invalid email address."],"LastName":["Last name is required."]},"traceId":"00-21b73606af87de2b7310df9e36cbccbb-a972e5555d549d52-00"}
```


## Validating a Minimal API
Minimal APIs have no `ModelState` and no action filters, but they have **endpoint filters**. A small generic filter can validate the request before the handler runs, for every endpoint that needs it:

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
            return Results.BadRequest();
        }

        var validationResult = await validator.ValidateAsync(request, context.HttpContext.RequestAborted);
        if (!validationResult.IsValid)
        {
            return Results.ValidationProblem(validationResult.ToDictionary());
        }

        return await next(context);
    }
}
```

`ToDictionary()` groups the errors by property name, which is exactly what `Results.ValidationProblem()` expects. Then we attach the filter to the endpoint:

```csharp
app.MapPost("/api/minimal/users", (CreateUserRequest request) =>
    {
        // Process the valid request...
        return Results.Ok();
    })
    .AddEndpointFilter<ValidationFilter<CreateUserRequest>>();
```

The handler stays clean, and the answer has the same shape as the controller's:

```
HTTP/1.1 400 Bad Request
Content-Type: application/problem+json

{"type":"https://tools.ietf.org/html/rfc9110#section-15.5.1","title":"One or more validation errors occurred.","status":400,"errors":{"LastName":["Last name is required."],"Email":["Invalid email address."]}}
```

> **_Note:_** Since .NET 10, Minimal APIs can also validate requests on their own: call `builder.Services.AddValidation()` and decorate the request with Data Annotations (`[Required]`, `[EmailAddress]`...). It is a good fit for simple rules. FluentValidation shines when the rules get richer: conditions, rules that depend on other properties, async checks, or validators you want to unit test on their own.


## Conclusion
FluentValidation is a powerful validation library for .NET applications. By leveraging FluentValidation, we can easily define and apply validation rules to our API endpoints, ensuring that incoming requests adhere to the specified criteria. By following a few simple steps, we can integrate FluentValidation into our projects, in controllers as well as in Minimal APIs, and return validation errors in a standard format.

Source code of the article: [Github source code](https://github.com/jboinembalome/IntroductionToFluentValidation)

*Thanks for reading! 🙂*