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

When minimal APIs arrived in .NET 6, they looked like a feature for demos: a `MapGet` in `Program.cs`, a lambda, no class. Four versions later, they have route groups, filters, typed results, OpenAPI metadata and, since .NET 10, built-in validation. Controllers have not gone anywhere either. A new project now starts with a real choice.


## The same endpoint, twice
One endpoint: get a product by id, `200` with the product or `404`. As a controller action:

```csharp
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

        return product is null ? NotFound() : Ok(product);
    }
}
```

As a minimal endpoint:

```csharp
public static class ProductEndpoints
{
    extension(IEndpointRouteBuilder endpoints)
    {
        public IEndpointRouteBuilder MapProductEndpoints()
        {
            endpoints.MapGroup("/api/products").MapGet("/{id:int}", GetAsync);

            return endpoints;
        }
    }

    private static async Task<Results<Ok<ProductDto>, NotFound>> GetAsync(
        int id,
        IProductsService productsService,
        CancellationToken cancellationToken)
    {
        var product = await productsService.TryGetAsync(id, cancellationToken);

        return product is null ? TypedResults.NotFound() : TypedResults.Ok(product);
    }
}
```

They are closer than the "one-liner in `Program.cs`" image suggests. A real minimal API is a static class per feature with named handlers, which reads much like a controller. The differences are elsewhere.

The **dependencies** are handler parameters, so each handler asks only for what it uses. A controller's constructor serves every action of the class.

The **return type** is the documentation. `Results<Ok<ProductDto>, NotFound>` lists the possible responses, and each `TypedResults` type describes itself to OpenAPI. The controller needs one `[ProducesResponseType]` per status code, and nothing checks that they match what the action returns. The compiler checks the union: returning `TypedResults.BadRequest()` does not compile until `BadRequest` joins it. Note that `Results.Ok(x)` returns a plain `IResult` and documents nothing; use `TypedResults`.


## What each style brings
Minimal APIs closed most of their gaps in .NET 7 and 8. `MapGroup` shares a prefix and conventions such as `RequireAuthorization()` across its endpoints. An `IEndpointFilter` runs around a handler. `[AsParameters]` binds a whole record from several sources. In .NET 10, `builder.Services.AddValidation()` validates Data Annotations on minimal endpoints and answers `400` before the handler runs, with code generated at compile time.

One difference is not a detail: **ASP.NET Core MVC does not support native AOT**, minimal APIs do. If a service must start in milliseconds or fit in a small container, controllers are out.

Controllers keep a richer pipeline. `[ApiController]` infers binding sources and turns an invalid model state into a problem details `400`. An `IModelBinder` decides how a type binds for every action; in a minimal API, a type binds through its own `TryParse` or `BindAsync`, which means owning the type. MVC filters come in stages (authorization, resource, action, exception, result), can be global, and can be built with services by an `IFilterFactory`. Endpoint filters cover "around the handler" and no more. And most versioning samples are written for controllers.

On performance, minimal APIs skip action selection, model binder providers and the filter pipeline, so they do less per request. In a business API that spends its time in the database, that is noise. Measure the real endpoint rather than a `Hello World` benchmark.


## Both, on purpose
[Blouppy Starter](https://starter.blouppy.com/) uses both, and each is where the code needs it.

The API is controller-based because it leans on MVC. Its `[InvalidatesCache<OrganizationId>]` attribute is an `IFilterFactory` whose action filter drops the organization's cached reads only after a successful action, so after its commit. Global action filters validate every paging query. A model binder provider binds every collection parameter from comma-separated or repeated query values. Versioning goes through `Asp.Versioning.Mvc`. Moving that API to minimal endpoints would mean rewriting all of it around `IResult`, for no gain.

The gateway takes the other route. It is a YARP reverse proxy that registers no MVC at all, and its three session endpoints, `/bff/login`, `/bff/logout` and `/bff/user`, are minimal handlers that redirect, challenge or sign out. The [BFF article](/blog/2026-05-10-keep-the-access-token-out-of-the-browser-bff-angular-yarp/) explains what they do. The API itself maps one minimal endpoint too: the OAuth protected resource metadata of its MCP server, at a path fixed by RFC 9728, outside the versioned routes, anonymous and excluded from the OpenAPI document.

Mixing has one cost worth knowing. The two styles have separate JSON options: `AddControllers().AddJsonOptions(...)` for controllers, `ConfigureHttpJsonOptions(...)` for minimal endpoints. The Starter sets the same converters in both. Forget the second, and enums serialize as numbers on the minimal endpoints only.


## How to choose
Pick **minimal APIs** for a new service with no investment in MVC, when native AOT or startup time matter, or when the host is not really an API: a gateway, a webhook receiver, a protocol document at a fixed path.

Pick **controllers** for a large, versioned API whose cross-cutting behaviour lives in MVC filters or custom model binders, or when a library you depend on targets MVC.

One host can map both: `MapControllers()` and `MapGet()` share the routing table, and authorization, rate limiting and output caching work for both. Move one feature at a time if there is a reason, and do not rewrite a working controller API for style.


## References
- [Choose between controller-based APIs and minimal APIs](https://learn.microsoft.com/aspnet/core/fundamentals/apis) — Microsoft Learn: the official comparison.
- [Create responses in Minimal API applications](https://learn.microsoft.com/aspnet/core/fundamentals/minimal-apis/responses) — Microsoft Learn: `TypedResults` and the `Results<...>` unions.
- [ASP.NET Core support for native AOT](https://learn.microsoft.com/aspnet/core/fundamentals/native-aot) — Microsoft Learn: which features support AOT.
- [Filters in ASP.NET Core](https://learn.microsoft.com/aspnet/core/mvc/controllers/filters) — Microsoft Learn: the MVC filter pipeline and `IFilterFactory`.
