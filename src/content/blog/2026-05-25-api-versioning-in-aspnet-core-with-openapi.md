---
templateKey: 'blog-post'
title: 'API versioning in ASP.NET Core, with an OpenAPI document per version'
date: 2026-05-25T09:00:00.000Z
author: Jimmy Boinembalome
authorimage: /img/jimmy.jpg
category: C#
topic: 'C# & .NET'
illustration: 1
categorycolor: bg-purple-100 text-purple-800
featuredpost: true
description: >-
  Learn when an ASP.NET Core API needs versions, how to read them with Asp.Versioning, how to deprecate one, and how to publish one OpenAPI document per version without Swashbuckle.
tags:
  - Development
  - C#
  - ASP.NET Core
  - OpenAPI
---

An API has clients we do not control. The day we rename a field or remove an endpoint, a mobile app released six months ago starts failing, and its users cannot fix it. Versioning lets the contract change while the old one keeps answering.

It has a price: two code paths, two documents, a deprecation to announce. Many APIs pay it for nothing.


## When you do not need a version
Only a **breaking** change needs a new version. Most changes are additive: a new endpoint, an optional parameter, a new property in a response (`System.Text.Json` ignores unknown properties by default). They ship in the current version. A breaking change is one an existing, correct client would notice: a removed or renamed property, a new required field, a different type or meaning.

Versioning is also overkill with **a single first-party client**. When the only consumer is your own SPA, deployed from the same commit, the two move together. A breaking change is one pull request. Versions pay off with clients you do not deploy: mobile apps, partner integrations, scripts written against a personal access token.

The version can travel in the URL (`/api/v1/orders`), a query string (`?api-version=1.0`), a header or the media type. URL segments win on discoverability, which is why most public APIs use them. Headers keep the URL stable, which matters when URLs are stored as identifiers.


## Asp.Versioning in a controller API
[Asp.Versioning](https://github.com/dotnet/aspnet-api-versioning) reads and validates the version. Its API explorer half describes each versioned endpoint to the OpenAPI generator:

```csharp
builder.Services
    .AddApiVersioning(options =>
    {
        options.DefaultApiVersion = new ApiVersion(1, 0);
        options.ReportApiVersions = true;
        options.ApiVersionReader = new UrlSegmentApiVersionReader();
    })
    .AddMvc()
    .AddApiExplorer(options =>
    {
        options.GroupNameFormat = "'v'VVV";
        options.SubstituteApiVersionInUrl = true;
    });
```

`GroupNameFormat = "'v'VVV"` turns version `1.0` into the group name `v1`; that name is how a document will pick its endpoints. `SubstituteApiVersionInUrl` writes `/api/v1/...` in the description instead of `/api/v{version}/...`. `ReportApiVersions` adds an `api-supported-versions` header to every response. In a controller-based API, `.AddMvc()` is required: since Asp.Versioning 10.2, an analyzer reports its absence.

A controller declares the versions it serves, and an action can be narrowed to one. Here `1.0` is also deprecated:

```csharp
[ApiController]
[ApiVersion("1.0", Deprecated = true)]
[ApiVersion("2.0")]
[Route("api/v{version:apiVersion}/orders")]
public sealed class OrdersController : ControllerBase
{
    [HttpGet("{id:int}")]
    [MapToApiVersion("1.0")]
    public ActionResult<OrderV1Dto> GetV1(int id) => ...;

    [HttpGet("{id:int}")]
    [MapToApiVersion("2.0")]
    public ActionResult<OrderV2Dto> GetV2(int id) => ...;
}
```

A request for an undeclared version gets a problem details response. Once more than a couple of actions differ, two controllers, one per namespace, read better than `MapToApiVersion`.


## Deprecating a version
A deprecated `1.0` keeps working. Its responses now also carry `api-deprecated-versions: 1.0`. That tells a client it should move. A **sunset policy** tells it when it must: `options.Policies.Sunset(1.0).Effective(date).Link(url)` adds a `Sunset` header and a `Link` to a human-readable page.

Headers are read by tools, rarely by people. A deprecation still needs an announcement, a date, and a look at the logs before that date to see who still calls the old version.

The built-in OpenAPI generator does not read the `Deprecated` flag by itself. An operation transformer copies it: when `context.Description.IsDeprecated()` is true, it sets `operation.Deprecated = true`.


## One OpenAPI document per version
Since .NET 9, ASP.NET Core generates OpenAPI documents with `Microsoft.AspNetCore.OpenApi`, no Swashbuckle. Each document is registered by name, and `MapOpenApi` serves it at `/openapi/{documentName}.json`:

```csharp
builder.Services.AddOpenApi("v1");
builder.Services.AddOpenApi("v2");

app.MapOpenApi();
```

By default, a document includes the endpoints whose API explorer group name equals its own name. With `GroupNameFormat = "'v'VVV"`, every `1.0` endpoint is in group `v1` and every `2.0` endpoint in `v2`, so the names line up with nothing else to write. When they cannot match, `options.ShouldInclude` replaces the rule. Transformers are registered per document, so a shared extension method keeps them identical.


## Starting with v1 and nothing else
[Blouppy Starter](https://starter.blouppy.com/) registers this stack with one version. Every route starts with `api/v{version:apiVersion}/`, and every controller declares `[ApiVersion(ApiVersions.V1)]`. It combines four readers (URL segment, query string, header, media type), but since the segment is always there, the others can only repeat it. A request that sends `/api/v1/...` with `X-Version: 2.0` is ambiguous and gets a `400`.

It publishes one document. Asp.Versioning 10 suggests moving to its own `Asp.Versioning.OpenApi` package (warnings `AV0029`, `AV0030`); the Starter suppresses both on purpose, since per-version documents are a decision for the day a second version ships. `Microsoft.Extensions.ApiDescription.Server` writes the document at build time, and the Web project's `OpenApiDocumentsDirectory` sends it to `api/` at the repository root. A reviewer then sees the contract change in a pull request. Nothing checks that the committed file is current, though; a CI step running `git diff --exit-code api/` after a build would.

That is the cheap way to start: a version in every URL from day one, which is the one thing hard to add later. The second version, the deprecation headers and the second document can wait for a breaking change that needs them.


## References
- [ASP.NET API Versioning](https://github.com/dotnet/aspnet-api-versioning) — GitHub: the `Asp.Versioning` packages, their wiki and samples.
- [Generate OpenAPI documents](https://learn.microsoft.com/aspnet/core/fundamentals/openapi/aspnetcore-openapi) — Microsoft Learn: `AddOpenApi`, several documents, `ShouldInclude`, build-time generation.
- [RFC 8594: The Sunset HTTP Header Field](https://www.rfc-editor.org/rfc/rfc8594) — IETF: the header a sunset policy writes.
- [HTTP File Generator](/blog/2026-04-26-http-file-generator/) — turning the published document into runnable `.http` requests.
