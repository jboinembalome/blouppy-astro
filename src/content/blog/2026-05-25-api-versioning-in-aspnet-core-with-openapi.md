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

An API has clients we do not control. The day we rename a field, remove an endpoint or change what a status code means, a mobile app released six months ago starts failing, and its users cannot fix it. Versioning gives us a way to change the contract while the old one keeps answering.

It also has a price: two code paths to maintain, two documents to publish, and a deprecation to announce. Many APIs pay it for nothing.

In this article, we will look at when an API needs versions at all, compare the four places a version can travel, wire [Asp.Versioning](https://github.com/dotnet/aspnet-api-versioning) into a controller-based API, deprecate a version with the right response headers, and publish one OpenAPI document per version with the built-in `Microsoft.AspNetCore.OpenApi`, no Swashbuckle. The real example comes from [Blouppy Starter](https://starter.blouppy.com/).


## When we do not need a version
A new version is only needed for a **breaking** change. Most changes are not breaking:

- adding an endpoint;
- adding an optional query parameter or an optional request property;
- adding a property to a response, as long as clients ignore what they do not know (`System.Text.Json` does by default).

These are additive, and they ship in the current version. A breaking change is one that an existing, correct client would notice: a removed or renamed property, a property that becomes required, a different type, a different meaning.

The second case where versioning is overkill is **a single first-party client**. When the only consumer is our own SPA, deployed with the API from the same commit, the API and its client move together. With a gateway in front of the SPA, as in [keeping the access token out of the browser](/blog/2026-05-10-keep-the-access-token-out-of-the-browser-bff-angular-yarp/), the browser never even calls the API directly. A breaking change is then a coordinated change in one pull request.

Versions start to pay off with clients we do not deploy: mobile apps, partners' integrations, scripts written against a personal access token, generated SDKs.


## Where the version travels
There are four common places to carry it:

| Style | Example | Notes |
| --- | --- | --- |
| URL segment | `GET /api/v1/workspaces` | Visible, cacheable, trivial to call from a browser or `curl`. The URL of a resource changes between versions. |
| Query string | `GET /api/workspaces?api-version=1.0` | Same URL path, easy to add. Easy to forget, so it needs a default. |
| Header | `X-Version: 1.0` | Clean URLs. Invisible in a link, and every client has to set it. |
| Media type | `Accept: application/json; v=1.0` | The most "RESTful" in theory. The least known, and awkward in most tooling. |

There is no universally right answer. URL segments win on discoverability, which is why most public APIs use them. Headers and media types keep the URL stable, which matters when URLs are stored as identifiers.


## Asp.Versioning in a controller-based API
`Asp.Versioning.Mvc` reads and validates the version; `Asp.Versioning.Mvc.ApiExplorer` describes each versioned endpoint to the API explorer, which is what the OpenAPI generator reads. The registration chains the two:

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

- `GroupNameFormat = "'v'VVV"` turns `1.0` into the group name `v1` (major, then the minor only when it is not zero). That group name is how a document will select its endpoints later.
- `SubstituteApiVersionInUrl = true` writes `/api/v1/...` in the description instead of `/api/v{version}/...`.
- `ReportApiVersions = true` adds the `api-supported-versions` header to every response, and `api-deprecated-versions` once a version is deprecated.

A controller then declares the versions it serves, and an action can be narrowed to one of them:

```csharp
[ApiController]
[ApiVersion("1.0")]
[ApiVersion("2.0")]
[Route("api/v{version:apiVersion}/workspaces")]
public sealed class WorkspacesController : ControllerBase
{
    [HttpGet("{id:int}")]
    [MapToApiVersion("1.0")]
    public ActionResult<WorkspaceV1Dto> GetV1(int id) => ...;

    [HttpGet("{id:int}")]
    [MapToApiVersion("2.0")]
    public ActionResult<WorkspaceV2Dto> GetV2(int id) => ...;
}
```

A request for a version no controller declares is refused with a problem details response. Splitting the two versions into two controllers, one per namespace, is often cleaner than `MapToApiVersion` once more than a couple of actions differ.


## The real example: Blouppy Starter
In Blouppy Starter, `AddApiSettingsServices` in the Web project registers the same stack, with four readers combined:

```csharp
services
    .AddApiVersioning(options =>
    {
        options.DefaultApiVersion = new ApiVersion(1, 0);
        options.ReportApiVersions = true;
        options.ApiVersionReader = ApiVersionReader.Combine(
            new UrlSegmentApiVersionReader(),
            new QueryStringApiVersionReader("api-version"),
            new HeaderApiVersionReader("X-Version"),
            new MediaTypeApiVersionReader("X-Version"));
    })
    // The API is controller-based, so the MVC half of the versioning
    // stack has to be registered explicitly.
    .AddMvc()
    .AddApiExplorer(options =>
    {
        options.GroupNameFormat = "'v'VVV";
        options.SubstituteApiVersionInUrl = true;
    });

services.AddOpenApi(options =>
{
    options.UseJwtBearerAuthentication();
});
```

`.AddMvc()` is not optional: since Asp.Versioning 10.2, the analyzer reports a controller-based API that registers only `AddApiVersioning()`. `UseJwtBearerAuthentication` is a small extension that adds a document transformer declaring the bearer security scheme on every operation.

The version string lives in one constant, and every controller uses it with the URL segment:

```csharp
public abstract class ApiVersions
{
    public const string V1 = "1.0";
}

[AllowAnonymous]
[ApiController]
[ApiVersion(ApiVersions.V1)]
[Produces("application/json")]
[Route("api/v{version:apiVersion}/billing/status")]
public sealed class BillingStatusController(
    IBillingAvailability billingAvailability) : ControllerBase
{
    [HttpGet(Name = RouteNames.Api.Billing.Status.Get)]
    [ProducesResponseType(StatusCodes.Status200OK)]
    public ActionResult<BillingStatusDto> Get()
        => Ok(new BillingStatusDto(billingAvailability.PaymentsEnabled));
}
```

Every route template in the API starts with `api/v{version:apiVersion}/`, and there is one version, `1.0`. The URL segment is therefore always present, so the three other readers can only repeat what it says. If a client sends `/api/v1/...` with `X-Version: 2.0`, the versions are ambiguous and the request is refused with a `400`. The extra readers cost nothing today; they are there for the day a resource is served without a segment.

The controllers are the driving adapters of the hexagon described in [hexagonal architecture in .NET](/blog/2026-05-04-hexagonal-architecture-in-dotnet/). Versioning stays in them: a `v2` DTO is mapped from the same `IXxxService` or `IXxxApiQueryService`, and the domain never learns which version asked.


## Deprecating a version
Deprecation is a flag on the attribute:

```csharp
[ApiVersion("1.0", Deprecated = true)]
[ApiVersion("2.0")]
[Route("api/v{version:apiVersion}/workspaces")]
public sealed class WorkspacesController : ControllerBase
```

`1.0` keeps working. With `ReportApiVersions` on, its responses now carry `api-supported-versions: 2.0` and `api-deprecated-versions: 1.0`.

The built-in OpenAPI generator does not read that flag on its own. An operation transformer copies it from the API explorer, so the reference UI shows the operations of `v1` as deprecated:

```csharp
builder.Services.AddOpenApi("v1", options =>
{
    options.AddOperationTransformer((operation, context, cancellationToken) =>
    {
        if (context.Description.IsDeprecated())
        {
            operation.Deprecated = true;
        }

        return Task.CompletedTask;
    });
});
```

A header tells a client that it should move. A **sunset policy** tells it when it must, through the `Sunset` header and a `Link` to a human-readable page:

```csharp
builder.Services.AddApiVersioning(options =>
{
    options.ReportApiVersions = true;
    options.Policies.Sunset(1.0)
        .Effective(new DateTimeOffset(2027, 1, 31, 0, 0, 0, TimeSpan.Zero))
        .Link("https://example.com/api/deprecation-policy")
            .Title("API versioning policy")
            .Type("text/html");
});
```

Headers are read by tools, rarely by people. The deprecation still needs an announcement, a date, and a look at the logs before the date, to see which clients still call the old version.


## One OpenAPI document per version
Since .NET 9, ASP.NET Core generates OpenAPI documents itself with `Microsoft.AspNetCore.OpenApi`. A document is registered by name, and `MapOpenApi` serves each one at `/openapi/{documentName}.json`:

```csharp
builder.Services.AddOpenApi("v1");
builder.Services.AddOpenApi("v2");

var app = builder.Build();

app.MapOpenApi();
```

How does each document pick its endpoints? By default, a document includes the endpoints whose API explorer **group name** equals the document's name, plus the endpoints that have no group name at all. With `GroupNameFormat = "'v'VVV"`, Asp.Versioning puts every `1.0` endpoint in group `v1` and every `2.0` endpoint in group `v2`, so the names line up and nothing else is needed. If the names cannot match, `ShouldInclude` replaces the rule:

```csharp
builder.Services.AddOpenApi("public-v2", options =>
{
    options.ShouldInclude = description => description.GroupName == "v2";
});
```

A document transformer, such as Blouppy's bearer scheme, is registered per document, so each `AddOpenApi` call needs its own. A shared extension method keeps them identical.

Asp.Versioning 10 also ships `Asp.Versioning.OpenApi`, which builds the document list from the API versions it discovers, and its analyzer (`AV0029`, `AV0030`) suggests moving to it. Blouppy Starter suppresses those two warnings on purpose: it publishes a single document, and moving to per-version documents is a decision for the day a second version ships, not for a package upgrade.

With only `AddOpenApi()` and no name, the document is called `v1`, which is why the Starter's single document is titled `Blouppy.Web | v1` and contains every `/api/v1/...` path.


## A published spec file in the repository
A running server serves the document. A file in the repository lets a reviewer see the contract change in a pull request, and lets a client be written or generated without starting anything.

`Microsoft.Extensions.ApiDescription.Server` writes the documents at build time. In Blouppy Starter, the Web project's `.csproj` sends the file to the `api/` folder at the repository root:

```xml
<PropertyGroup>
  <OpenApiDocumentsDirectory>..\..\api</OpenApiDocumentsDirectory>
  <OpenApiGenerateDocumentsOptions>--file-name blouppy-openapi-spec</OpenApiGenerateDocumentsOptions>
</PropertyGroup>

<ItemGroup>
  <PackageReference Include="Microsoft.AspNetCore.OpenApi" />
  <PackageReference Include="Microsoft.Extensions.ApiDescription.Server">
    <PrivateAssets>all</PrivateAssets>
  </PackageReference>
</ItemGroup>
```

Every `dotnet build` of the Web project rewrites `api/blouppy-openapi-spec.json`, an OpenAPI 3.1 document, and the file is committed. The front-end API clients are written by hand against it, and the CI's `back` job runs when anything under `api/` changes. With several documents registered, the build writes all of them unless `--document-name` restricts it to one.

The Starter does not check that the committed file is up to date: a developer who changes a controller and forgets to commit the regenerated file leaves the two out of sync. A cheap guard is a CI step that builds the Web project and runs `git diff --exit-code api/`, which fails when the build changed the file.

The generation runs the application's startup to build the document, so anything that startup needs, a connection string or a required option, has to be satisfiable at build time. Code that must not run during generation can check `Assembly.GetEntryAssembly()?.GetName().Name == "GetDocument.Insider"`.

Once the file exists, it feeds other tools: the [HTTP File Generator](/blog/2026-04-26-http-file-generator/) turns it into runnable `.http` requests.


## What it costs
- **Two contracts to keep alive.** Every bug fix lands in both versions, and every test runs against both.
- **A deprecation process.** A version that is never removed is a version maintained forever.
- **More documents.** Each one needs its transformers registered, and each one is a file to review.
- **A version in every URL from day one.** That is cheap, and it is the one choice that is hard to add later without breaking the clients we already have.

Starting with `v1` in the URL and nothing else, as the Starter does, keeps all the options open for the price of one route segment. The second version, the deprecation headers and the second document can wait until a breaking change actually needs them.


## Conclusion
Most changes are additive and need no version at all, and an API with a single first-party client can move with it. When clients we do not deploy appear, Asp.Versioning reads the version from the URL, a query string, a header or the media type, `ReportApiVersions` and a sunset policy tell those clients where things are heading, and the built-in `Microsoft.AspNetCore.OpenApi` publishes one document per version by matching document names to the group names that `GroupNameFormat` produces.

[Blouppy Starter](https://starter.blouppy.com/) is ready for that day: every route carries `v{version:apiVersion}`, the versioning stack is registered, and the single `v1` document is written to `api/` on every build.

## References
- [ASP.NET API Versioning (GitHub)](https://github.com/dotnet/aspnet-api-versioning) — the `Asp.Versioning` packages, their wiki and samples.
- [Version sunset policies (ASP.NET API Versioning wiki)](https://github.com/dotnet/aspnet-api-versioning/wiki/Version-Policies) — `Policies.Sunset`, the `Sunset` and `Link` headers.
- [Overview of OpenAPI support in ASP.NET Core API apps (Microsoft Learn)](https://learn.microsoft.com/aspnet/core/fundamentals/openapi/overview) — `Microsoft.AspNetCore.OpenApi`.
- [Generate OpenAPI documents (Microsoft Learn)](https://learn.microsoft.com/aspnet/core/fundamentals/openapi/aspnetcore-openapi) — `AddOpenApi`, multiple documents, `ShouldInclude`, build-time generation with `OpenApiDocumentsDirectory`.
- [Customize OpenAPI documents (Microsoft Learn)](https://learn.microsoft.com/aspnet/core/fundamentals/openapi/customize-openapi) — document and operation transformers.
- [RFC 8594: The Sunset HTTP Header Field (IETF)](https://www.rfc-editor.org/rfc/rfc8594) — the header a sunset policy writes.
- [OpenAPI Specification](https://spec.openapis.org/oas/latest.html) — the format of the published document.
