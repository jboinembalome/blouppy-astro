---
templateKey: 'blog-post'
title: 'Minimal APIs or controllers in ASP.NET Core?'
date: 2026-05-31T09:00:00.000Z
author: Jimmy Boinembalome
authorimage: /img/jimmy.jpg
category: C#
topic: 'C# & .NET'
illustration: 2
categorycolor: bg-purple-100 text-purple-800
featuredpost: true
description: >-
  Learn what minimal APIs and controllers each bring in .NET 10, see the same endpoint written both ways, and decide which style fits an API, a gateway or a single endpoint.
tags:
  - Development
  - C#
  - ASP.NET Core
  - Minimal API
---

When minimal APIs arrived in .NET 6, they looked like a feature for demos: a `MapGet` in `Program.cs`, a lambda, no class. Four versions later, they have route groups, filters, typed results, OpenAPI metadata and, since .NET 10, built-in validation. Controllers have not gone anywhere either. A new project now starts with a real choice, and the template's default is not an argument.

In this article, we will look at what minimal APIs can do in .NET 10, what controllers still bring, what the performance difference really is, and write the same endpoint both ways. Then we will look at a code base that uses both styles on purpose, and finish with a short decision guide.


## The same endpoint, twice
Let's take one endpoint: get a product by id, `200` with the product or `404`.

As a controller action:

```csharp
namespace Shop.Web.Controllers;

[ApiController]
[Route("api/products")]
public sealed class ProductsController(IProductsService productsService) : ControllerBase
{
    [HttpGet("{id:int}")]
    [ProducesResponseType<ProductDto>(StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status404NotFound)]
    public async Task<ActionResult<ProductDto>> GetAsync(int id, CancellationToken cancellationToken)
    {
        var product = await productsService.TryGetAsync(id, cancellationToken);

        return product is null
            ? NotFound()
            : Ok(product);
    }
}
```

As a minimal endpoint:

```csharp
namespace Shop.Web.Products;

public static class ProductEndpoints
{
    extension(IEndpointRouteBuilder endpoints)
    {
        public IEndpointRouteBuilder MapProductEndpoints()
        {
            var products = endpoints.MapGroup("/api/products");

            products.MapGet("/{id:int}", GetAsync);

            return endpoints;
        }
    }

    private static async Task<Results<Ok<ProductDto>, NotFound>> GetAsync(
        int id,
        IProductsService productsService,
        CancellationToken cancellationToken)
    {
        var product = await productsService.TryGetAsync(id, cancellationToken);

        return product is null
            ? TypedResults.NotFound()
            : TypedResults.Ok(product);
    }
}
```

The two are closer than the "one-liner in `Program.cs`" image suggests. A real minimal API is a static class per feature with named handlers, which reads much like a controller. The differences are elsewhere:

- The **dependencies** are handler parameters: `IProductsService` is resolved from the container per request, so each handler asks only for what it uses. A controller's constructor serves every action of the class.
- The **return type** is the documentation. `Results<Ok<ProductDto>, NotFound>` is a union of the possible responses, and each `TypedResults` type describes itself to the endpoint metadata, so OpenAPI knows both the `200` with its body and the `404` without an attribute. The controller needs a `[ProducesResponseType]` per status code, and nothing checks that they match what the action returns.
- The compiler checks the union too: returning `TypedResults.BadRequest()` from that handler does not compile until `BadRequest` joins the union.


## What minimal APIs can do in .NET 10
Most of the gaps of .NET 6 were closed in .NET 7 and 8:

- **Route groups**. `MapGroup("/api/products")` shares a prefix and conventions: `RequireAuthorization()`, `RequireRateLimiting()`, `CacheOutput()`, `WithTags()` set once on the group apply to every endpoint inside it.
- **Endpoint filters**. An `IEndpointFilter` runs around the handler and can read its arguments or short-circuit with a result. `AddEndpointFilter<T>()` works on an endpoint or a group. The [FluentValidation article](/blog/2023-06-03-validating-requests-with-fluentvalidation/) builds a validation filter this way.
- **Parameter binding**. Route, query, header, JSON body, form (with antiforgery), services, `HttpContext`, `CancellationToken`. `[AsParameters]` binds a whole record from several sources, and a type can take part in binding with a static `TryParse` or `BindAsync`.
- **Built-in validation**, new in .NET 10. After `builder.Services.AddValidation()`, the parameters and request types of minimal endpoints are validated against their Data Annotations, and an invalid request gets a `400` with a validation problem details body before the handler runs:

```csharp
builder.Services.AddValidation();
```

```csharp
public sealed class ProductCreationDto
{
    [Required]
    [StringLength(100)]
    public string? Name { get; init; }

    [Range(0, 100_000)]
    public decimal Price { get; init; }
}
```

  The validation code is generated at compile time, and `DisableValidation()` turns it off for one endpoint.
- **OpenAPI**. `Microsoft.AspNetCore.OpenApi` generates the document for both styles; in .NET 10 it produces OpenAPI 3.1 by default. `WithName`, `WithSummary`, `Produces` and `ExcludeFromDescription` complete what the return types already say.
- **Native AOT**. This one is not a detail: ASP.NET Core MVC does not support native AOT, minimal APIs do. With `PublishAot`, the Request Delegate Generator writes the binding code at compile time instead of building it with reflection at startup. If a service must start in milliseconds or fit in a small container, controllers are out.


## What controllers still bring
Controllers are not the legacy option. They carry a decade of features that minimal APIs either do differently or do not have:

- **Conventions**. `[ApiController]` infers binding sources, answers `400` with problem details when the model state is invalid, and turns error status codes into problem details. Application model conventions can rewrite every route at once, such as slugifying controller names.
- **Model binding extensibility**. An `IModelBinder` and an `IModelBinderProvider` decide how a type binds for every action. Minimal APIs have no equivalent registry: a type binds through its own `TryParse` or `BindAsync`, which means owning the type.
- **The filter pipeline**. Authorization, resource, action, exception and result filters, global ones in `MvcOptions.Filters`, attribute-based ones, and `IFilterFactory` to build a filter with services. Endpoint filters cover the "around the handler" case, which is enough for most filters, but there is no global registry and no separate authorization, resource or result stage.
- **Validation of `ModelState`**. Controllers validate Data Annotations and `IValidatableObject` too, and have done so since the beginning. The .NET 10 validation brings minimal APIs to the same level; it does not go beyond it.
- **Versioning and ApiExplorer maturity**. [Asp.Versioning](https://github.com/dotnet/aspnet-api-versioning) supports both styles, with `Asp.Versioning.Mvc` for controllers and `Asp.Versioning.Http` for minimal APIs, but most samples, articles and existing code bases are written for controllers.
- **Familiarity**. Anyone who knows ASP.NET Core knows `[HttpGet]` and `ControllerBase`; where minimal handlers live is a convention each team invents.


## Performance, modestly
Minimal APIs skip the MVC machinery: no action selection over controller descriptors, no model binder providers, no filter pipeline unless filters are added. So the framework does less work per request, and allocates less.

In a typical business API, that overhead is a small part of a request that spends most of its time in the database or another service. If performance is the argument, measure the real endpoint with [BenchmarkDotNet](/blog/2022-10-22-introduction-to-benchmarkdotnet/) or a load test; do not choose a style for a benchmark of `Hello World`. Startup time and memory under native AOT are the cases where the difference is real, and there the choice is made for us.


## Both styles in one code base
[Blouppy Starter](https://starter.blouppy.com/) is a good example because it uses both, and the code says why each one is where it is.

The API is **controller-based**. A typical action, trimmed:

```csharp
[Authorize]
[ApiController]
[ApiVersion(ApiVersions.V1)]
[Produces("application/json")]
[Route("api/v{version:apiVersion}/organizations/{organizationId:int}/settings")]
public sealed class OrganizationSettingsController(
    IOrganizationSettingsService organizationSettingsService,
    IAuthorizationService authorizationService,
    IUnitOfWork unitOfWork) : ControllerBase
{
    [HttpPut(Name = RouteNames.Api.Organizations.Settings.Update)]
    [InvalidatesCache<OrganizationId>]
    [ProducesResponseType(StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status400BadRequest)]
    public async Task<ActionResult<OrganizationSettingsDto>> UpdateAsync(
        int organizationId,
        OrganizationSettingsEditionDto organizationSettingsEditionDto,
        CancellationToken cancellationToken)
    {
        var typedOrganizationId = new OrganizationId(organizationId);

        if (!await authorizationService.IsAuthorizedAsync(User, typedOrganizationId, Policies.Manage))
        {
            return Forbid();
        }

        var edition = OrganizationSettingsMapper.MapToEdition(typedOrganizationId, organizationSettingsEditionDto);

        var result = await organizationSettingsService.TryUpdateAsync(edition, cancellationToken);

        return await result.MatchAsync(
            onSuccess: async organizationSettings =>
            {
                await unitOfWork.CommitAsync(cancellationToken);

                return Ok(OrganizationSettingsMapper.MapToDto(organizationSettings));
            },
            onFailed: BadRequest);
    }
}
```

Several things in it are MVC features the API leans on:

- **`[InvalidatesCache<OrganizationId>]`** is an `IFilterFactory` that creates an `IAsyncActionFilter`. It awaits the action, checks that the `IActionResult` is a success, and only then drops the cached reads of the organization. Its comment gives the ordering reason: after the action body, so after its `unitOfWork.CommitAsync`, otherwise a concurrent reader could cache pre-commit rows.
- **Global action filters** validate every paging and sorting query: `CursorQueryValidationFilter` looks for an argument implementing `ICursorQueryDto` on any action and answers `400` when its limit is out of range.
- **A model binder provider**, `GenericCollectionModelBinderProvider`, binds every array or generic collection parameter from comma-separated or repeated query values, deduplicated.
- **A route convention**, `RouteTokenTransformerConvention` with a `SlugifyParameterTransformer`, and **versioning** through `Asp.Versioning.Mvc`. The registration says it in a comment: the API is controller-based, so the MVC half of the versioning stack has to be registered explicitly.

Moving that API to minimal APIs would mean rewriting the filters around `IResult`, binding collections another way and switching the versioning package, for no gain.

The **gateway** takes the other route. It is a YARP reverse proxy with a cookie session, and it owns three endpoints of its own, `/bff/login`, `/bff/logout` and `/bff/user` (the [BFF article](/blog/2026-05-10-keep-the-access-token-out-of-the-browser-bff-angular-yarp/) explains what they do). It does not register MVC at all; the three endpoints are mapped directly:

```csharp
public static class SessionEndpoints
{
    extension(IEndpointRouteBuilder endpoints)
    {
        public IEndpointRouteBuilder MapSessionEndpoints()
        {
            endpoints.MapGet(SessionPaths.Login, Login);
            endpoints.MapGet(SessionPaths.Logout, LogoutAsync);
            endpoints.MapGet(SessionPaths.User, UserAsync);

            return endpoints;
        }
    }

    private static IResult Login(HttpContext context, string? returnUrl)
    {
        var target = AppPath(returnUrl);

        if (target is null)
        {
            return Results.BadRequest();
        }

        return context.User.Identity?.IsAuthenticated == true
            ? Results.LocalRedirect(target)
            : Results.Challenge(new AuthenticationProperties { RedirectUri = target }, [SessionSchemes.OpenIdConnect]);
    }
}
```

Three handlers that redirect, challenge or sign out need no conventions, versioning or OpenAPI document, and each one resolves only what it uses (`LogoutAsync` takes `UserAccessTokens`, `UserAsync` a `TimeProvider`).

The API itself has one minimal endpoint too: the protected resource metadata of its MCP server, the JSON document a connector reads to find the authorization server. It lives at `/.well-known/oauth-protected-resource`, a path fixed by RFC 9728 and outside the versioned `api/v{version}` routes, and is mapped on two paths in a loop:

```csharp
endpoints
    .MapGet(path, (HttpContext context, McpProtectedResource resource) =>
    {
        // The same for every caller, and only changes with the deployment.
        context.Response.Headers.CacheControl = "public, max-age=3600";

        return TypedResults.Json(ProtectedResourceMetadata.For(resource));
    })
    .AllowAnonymous()
    .ExcludeFromDescription();
```

`AllowAnonymous()` and `ExcludeFromDescription()` say what it is: a protocol document anyone may read, left out of the API's OpenAPI document. The health checks (`MapHealthChecks`) and the MCP endpoint itself, mapped by the MCP SDK's `MapMcp`, are endpoints of the same kind next to the controllers.

One detail shows the cost of mixing: the Starter configures JSON twice. `AddControllers().AddJsonOptions(...)` sets the controllers' serializer, `ConfigureHttpJsonOptions(...)` sets the one minimal APIs and `TypedResults.Json` use, with the same converters in both. They are separate options, and forgetting the second one makes enums serialize as numbers on the minimal endpoints only.


## How to choose
Choose **minimal APIs** when:

- The service is new and has no investment in MVC filters, binders or conventions.
- Native AOT, startup time or a small footprint matter: controllers cannot follow.
- The host is not an API: a gateway, a worker with a health endpoint, a webhook receiver, a protocol endpoint at a fixed path.
- You want the response types checked by the compiler and documented by the return type.

Choose **controllers** when:

- The API is large, versioned and documented, and the team already knows the conventions.
- Cross-cutting behaviour lives in MVC filters (caching, auditing, validation of shared query shapes) or custom model binders.
- A library you depend on targets MVC.

And **it depends** is a real answer: one host can map both. `MapControllers()` and `MapGet()` live in the same routing table, and authorization, rate limiting and output caching are endpoint metadata that work for both. Move to minimal APIs one feature at a time if there is a reason, and do not rewrite a working controller-based API for style. For a small internal API with ten endpoints, either is fine; pick the one the team reads fastest.

Some pitfalls whichever style we pick:

- **Two JSON configurations** when both styles coexist, as above.
- **`Results` versus `TypedResults`.** `Results.Ok(x)` returns `IResult` and gives OpenAPI nothing; `TypedResults.Ok(x)` in a `Results<...>` union documents itself.


## Conclusion
In .NET 10, minimal APIs are no longer the small sibling: route groups, endpoint filters, typed unions, OpenAPI and built-in validation cover what most APIs need, and only they support native AOT. Controllers keep the richer pipeline: conventions, model binders, global and result filters, and the most mature versioning story. Blouppy Starter keeps its domain API on controllers because it leans on MVC filters and binders, and maps a handful of handlers that need none of that as minimal endpoints. Pick per host, and per feature when a host needs both.


## References
- [Choose between controller-based APIs and minimal APIs (Microsoft Learn)](https://learn.microsoft.com/aspnet/core/fundamentals/apis) — Microsoft's own comparison of the two styles.
- [Minimal APIs quick reference (Microsoft Learn)](https://learn.microsoft.com/aspnet/core/fundamentals/minimal-apis) — route groups, binding and validation with `AddValidation`.
- [Create responses in Minimal API applications (Microsoft Learn)](https://learn.microsoft.com/aspnet/core/fundamentals/minimal-apis/responses) — `TypedResults` and the `Results<...>` union types.
- [Filters in Minimal API apps (Microsoft Learn)](https://learn.microsoft.com/aspnet/core/fundamentals/minimal-apis/min-api-filters) — `IEndpointFilter` and `AddEndpointFilter`.
- [Filters in ASP.NET Core (Microsoft Learn)](https://learn.microsoft.com/aspnet/core/mvc/controllers/filters) — the MVC filter pipeline and `IFilterFactory`.
- [Custom model binding (Microsoft Learn)](https://learn.microsoft.com/aspnet/core/mvc/advanced/custom-model-binding) — `IModelBinder` and `IModelBinderProvider`.
- [ASP.NET Core support for native AOT (Microsoft Learn)](https://learn.microsoft.com/aspnet/core/fundamentals/native-aot) — which features support native AOT, and the Request Delegate Generator.
- [Generate OpenAPI documents (Microsoft Learn)](https://learn.microsoft.com/aspnet/core/fundamentals/openapi/aspnetcore-openapi) — `Microsoft.AspNetCore.OpenApi` for both styles.
- [ASP.NET API Versioning (GitHub)](https://github.com/dotnet/aspnet-api-versioning) — `Asp.Versioning.Mvc` and `Asp.Versioning.Http`.
- [RFC 9728: OAuth 2.0 Protected Resource Metadata (IETF)](https://datatracker.ietf.org/doc/html/rfc9728) — the document behind the Starter's well-known endpoint.
