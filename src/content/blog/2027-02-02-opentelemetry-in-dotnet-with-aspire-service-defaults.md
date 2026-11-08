---
templateKey: 'blog-post'
title: 'OpenTelemetry in .NET with Aspire ServiceDefaults: traces, metrics and logs'
date: 2027-02-02T09:00:00.000Z
author: Jimmy Boinembalome
authorimage: /img/jimmy.jpg
category: C#
topic: 'C# & .NET'
illustration: 2
categorycolor: bg-purple-100 text-purple-800
featuredpost: true
description: >-
  Learn what Aspire's AddServiceDefaults wires for OpenTelemetry in .NET, how to add your own spans and metrics, and how to send them to a real backend in production.
tags:
  - Development
  - C#
  - .NET Aspire
  - ASP.NET Core
---

A request goes through the gateway, the API, PostgreSQL and RabbitMQ, then a consumer sends an e-mail. It fails somewhere. Each host has written its own log lines, in its own container, and nothing ties them together. We grep timestamps and guess.

[OpenTelemetry](https://opentelemetry.io/docs/languages/dotnet/) fixes this with three signals that share one context: **traces** (what happened, across processes), **metrics** (how often and how long) and **logs** (with the trace id attached). In .NET, the APIs are already in the runtime (`ActivitySource`, `Meter`, `ILogger`); OpenTelemetry collects and exports them.

In this article, we will read what Aspire's `AddServiceDefaults` actually wires, look at the dashboard in development, add our own spans and metrics, light up EF Core, Npgsql, Wolverine and Redis, and send everything to a real backend in production. The real example is [Blouppy Starter](https://starter.blouppy.com/), whose three hosts and migration runner all start with `builder.AddServiceDefaults()`.


## What AddServiceDefaults wires
The Aspire template generates a `ServiceDefaults` project that every host references. Its entry point is short:

```csharp
public static TBuilder AddServiceDefaults<TBuilder>(this TBuilder builder)
    where TBuilder : IHostApplicationBuilder
{
    builder.ConfigureOpenTelemetry();

    builder.AddDefaultHealthChecks();

    builder.Services.AddServiceDiscovery();

    builder.Services.ConfigureHttpClientDefaults(http =>
    {
        http.AddStandardResilienceHandler();
        http.AddServiceDiscovery();
    });

    return builder;
}
```

The resilience handler applied to every `HttpClient` has its own trap, covered in [The AddStandardResilienceHandler trap](/blog/2026-06-15-the-addstandardresiliencehandler-trap/). Here we care about `ConfigureOpenTelemetry`. In the Starter, it reads:

```csharp
public static TBuilder ConfigureOpenTelemetry<TBuilder>(this TBuilder builder)
    where TBuilder : IHostApplicationBuilder
{
    builder.Logging.AddOpenTelemetry(logging =>
    {
        logging.IncludeFormattedMessage = true;
        logging.IncludeScopes = true;
    });

    // Required by MailKit to enable metrics
    Telemetry.SmtpClient.Configure();

    builder.Services.AddOpenTelemetry()
        .WithMetrics(metrics => metrics
            // Wolverine names its meter after the service (Wolverine:blouppy), hence the wildcard.
            .AddMeter("Wolverine*")
            .AddMeter(Telemetry.SmtpClient.MeterName)
            .AddAspNetCoreInstrumentation()
            .AddHttpClientInstrumentation()
            .AddRuntimeInstrumentation())
        .WithTracing(tracing => tracing
            .AddSource(builder.Environment.ApplicationName)
            .AddSource("Wolverine")
            .AddSource(Telemetry.SmtpClient.ActivitySourceName)
            .AddAspNetCoreInstrumentation()
            .AddHttpClientInstrumentation());

    builder.AddOpenTelemetryExporters();

    return builder;
}
```

Three things happen:
- **Logs** go through an OpenTelemetry logger provider. `IncludeFormattedMessage` keeps the rendered message next to the template and its parameters; `IncludeScopes` exports the values of `BeginScope`. Every log written inside a request carries that request's trace id and span id.
- **Metrics** come from ASP.NET Core (request duration, active requests), `HttpClient`, the runtime (GC, thread pool) and every `Meter` whose name is listed with `AddMeter`.
- **Traces** come from ASP.NET Core, `HttpClient` and every `ActivitySource` listed with `AddSource`.

The lists are the important part. The runtime and the libraries create `ActivitySource`s and `Meter`s whether or not anyone listens. OpenTelemetry subscribes **only to the names we give it**. A source that is not listed costs almost nothing and exports nothing.

The exporter is added on one condition:

```csharp
private static TBuilder AddOpenTelemetryExporters<TBuilder>(this TBuilder builder)
    where TBuilder : IHostApplicationBuilder
{
    var useOtlpExporter = !string.IsNullOrWhiteSpace(builder.Configuration["OTEL_EXPORTER_OTLP_ENDPOINT"]);

    if (useOtlpExporter)
    {
        builder.Services.AddOpenTelemetry().UseOtlpExporter();
    }

    return builder;
}
```

`UseOtlpExporter` registers one OTLP exporter for the three signals at once, configured by the standard `OTEL_EXPORTER_OTLP_*` variables (endpoint, protocol, headers). Without the variable, the host collects nothing beyond what it needs for its console logs, and no code path changes. That is what makes the same binary run under Aspire, in a test and in a container.


## The dashboard in development
We never set `OTEL_EXPORTER_OTLP_ENDPOINT` by hand in development. When the AppHost starts a project with `AddProject<Projects.Blouppy_Web>("blouppy-api")`, it injects the variables that point the project at the Aspire dashboard's OTLP endpoint, along with `OTEL_SERVICE_NAME` set to the resource name. Each host shows up under its own name, and the dashboard gives us structured logs filterable by property, traces across hosts and the metrics, without installing anything.

In the Starter, a request through the gateway shows as one trace with the API's request under it, then the Npgsql commands and the Wolverine spans it caused. The [end-to-end tests built on Aspire.Hosting.Testing](/blog/2026-09-25-end-to-end-tests-with-aspire-hosting-testing/) start the same AppHost graph, so the telemetry of a failing scenario is wired the same way.


## Libraries that bring their own instrumentation
Several libraries in the Starter emit telemetry. Each needs one of two things: its name listed in `ConfigureOpenTelemetry`, or an Aspire client integration that lists it for us.

**Wolverine** publishes an `ActivitySource` named `Wolverine`, and a meter whose name includes the service name, hence `AddMeter("Wolverine*")` (wildcards are accepted). Its spans show the send, the receive and the handler, so a message consumed by another host joins the trace of the request that published it. The move to Wolverine itself is told in [Replacing MassTransit with Wolverine](/blog/2026-06-09-replacing-masstransit-with-wolverine/).

**MailKit** needs to be switched on before it emits anything: `Telemetry.SmtpClient.Configure()` creates its source and meter, and their names come from the same class.

**EF Core and Npgsql** come through the Aspire client integration `Aspire.Npgsql.EntityFrameworkCore.PostgreSQL`. Each `DbContext` keeps its own `AddDbContext` registration (migrations history table, interceptors), then asks Aspire to enrich it:

```csharp
public IHostApplicationBuilder AddBlouppyDbContext()
{
    builder.Services.AddDbContext<BlouppyDbContext>((serviceProvider, options) => options
        .UseNpgsql(builder.Configuration.GetConnectionString("blouppy-db"), npgsqlOptions => npgsqlOptions
            .MigrationsHistoryTable(HistoryRepository.DefaultTableName, Schemas.Blouppy))
        .AddInterceptors(serviceProvider.GetServices<ISaveChangesInterceptor>()));

    builder.EnrichNpgsqlDbContext<BlouppyDbContext>();

    return builder;
}
```

`EnrichNpgsqlDbContext` adds Npgsql's tracing and metrics and a health check of the context. The Billing, identity and gateway contexts do the same. We get one span per SQL command, with the statement, under the request that ran it.

**Redis** comes through `Aspire.StackExchange.Redis.DistributedCaching`. `AddRedisDistributedCache` wires the tracing of the connection; the Starter turns its health check off on purpose, because the response cache is an optimization, and a Redis outage must not take the API out of its load balancer's rotation:

```csharp
builder.AddRedisDistributedCache(CacheConnectionName, settings => settings.DisableHealthChecks = true);
```

The health checks share the project with telemetry. `/health` runs every check and `/alive` only the ones tagged `live`, and both answer with the status alone, never which check failed or why: the details are in the logs and the traces. The compose file's container healthcheck calls `/health` every fifteen seconds.


## Our own spans and metrics
The libraries tell us that a SQL command took 40 ms. They cannot tell us that a webhook delivery was retried or that an export took ten seconds because the person owns 300 files. That is what our own `ActivitySource` and `Meter` are for.

A span is an `Activity`. In a generic shop, we create one source per component, with a stable name, and start activities from it:

```csharp
using System.Diagnostics;

namespace Shop.Exports;

internal static class ExportTelemetry
{
    public const string SourceName = "Shop.Exports";

    public static readonly ActivitySource Source = new(SourceName);
}

internal sealed class OrderExportBuilder(IOrdersRepository ordersRepository)
{
    public async Task<IReadOnlyList<Order>> BuildAsync(CustomerId customerId, CancellationToken cancellationToken)
    {
        using var activity = ExportTelemetry.Source.StartActivity("export.orders");

        var orders = await ordersRepository.ListByCustomerAsync(customerId, cancellationToken);

        activity?.SetTag("export.orders.count", orders.Count);

        return orders;
    }
}
```

`StartActivity` returns `null` when nothing listens, hence the `?.`. The span becomes a child of whatever is current, the request or the message handler, without passing anything around.

For metrics, .NET 8 added `IMeterFactory`, registered by the host. A meter created from it is owned by the container and plays well with tests:

```csharp
using System.Diagnostics.Metrics;

namespace Shop.Webhooks;

internal sealed class WebhookMetrics
{
    public const string MeterName = "Shop.Webhooks";

    private readonly Counter<long> _deliveries;

    public WebhookMetrics(IMeterFactory meterFactory)
    {
        var meter = meterFactory.Create(MeterName);

        _deliveries = meter.CreateCounter<long>("shop.webhooks.deliveries");
    }

    public void Delivered(bool succeeded)
        => _deliveries.Add(1, new KeyValuePair<string, object?>("outcome", succeeded ? "success" : "failure"));
}
```

Both names then go into `ConfigureOpenTelemetry`, next to Wolverine's:

```csharp
.WithMetrics(metrics => metrics.AddMeter(WebhookMetrics.MeterName))
.WithTracing(tracing => tracing.AddSource(ExportTelemetry.SourceName))
```

The template's `AddSource(builder.Environment.ApplicationName)` only covers a source named after the host's assembly (`Blouppy.Web`). In a hexagonal solution, where the work happens in domain and module projects, the sources usually have other names, and each one must be listed. A shared prefix and a wildcard (`AddSource("Shop.*")`) keep that list short.

Keep tag values bounded. `outcome` has two values; a user id or a URL as a metric tag creates one time series per value, and backends bill or slow down per series. High-cardinality values belong on spans and logs.


## Exporting in production
The Starter's `deploy/` directory runs PostgreSQL, RabbitMQ, Redis, Caddy, the migration runner and the hosts with Docker Compose. It ships **no collector**. Every .NET host reads the same `.env` file, which leaves the choice open:

```bash
# An OpenTelemetry collector (OTLP) the hosts send their traces, metrics and logs to.
# Empty, they log to the console only (`docker compose logs`).
OTEL_EXPORTER_OTLP_ENDPOINT=
# OTEL_EXPORTER_OTLP_PROTOCOL=grpc
# OTEL_EXPORTER_OTLP_HEADERS=Authorization=Bearer ...
```

With the variable empty, `docker compose logs -f gateway identity api` is the observability. With it set, the hosts export, and the console logs stay. The endpoint can be a hosted backend that accepts OTLP directly (with its key in `OTEL_EXPORTER_OTLP_HEADERS`), or a collector container added to the compose file, such as the OpenTelemetry Collector or Grafana Alloy, which batches, filters and forwards. For a staging box, the standalone Aspire dashboard image accepts OTLP too, but it keeps everything in memory and loses it on restart.

The protocol matters: the .NET exporter defaults to gRPC on port 4317. A backend that only accepts HTTP needs `OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf` and its 4318 endpoint.


## Pitfalls
**The service name.** Aspire sets `OTEL_SERVICE_NAME` for each resource; the compose file does not. Without it, the OpenTelemetry SDK falls back to `unknown_service:` and the process name, and each image runs `dotnet <assembly>.dll`, so the three hosts would arrive under the same name. Since the `.env` file is shared, the name goes in each service's `environment:` block:

```yaml
api:
  environment:
    <<: *dotnet-environment
    OTEL_SERVICE_NAME: blouppy-api
```

**A meter nobody listens to.** The Starter's identity host keeps the counters of its sign-in pages (`tokenservice.user_login`, `tokenservice.consent`) on a static `Meter` named after its assembly, and as the code stands, no `AddMeter` lists that name. The counters are incremented and never exported. Nothing fails, which is the problem: check each custom name in the dashboard once.

**Health checks in the traces.** The container healthcheck calls `/health` every fifteen seconds on each host, and each call is a span. A filter on the ASP.NET Core instrumentation drops them:

```csharp
.AddAspNetCoreInstrumentation(options => options.Filter = context =>
    !context.Request.Path.StartsWithSegments(Extensions.ReadinessPath)
    && !context.Request.Path.StartsWithSegments(Extensions.LivenessPath))
```

**Volume.** The default sampler records every trace. On a busy API, a backend billed by span grows quickly. `SetSampler(new ParentBasedSampler(new TraceIdRatioBasedSampler(0.1)))` keeps one trace in ten and follows the caller's decision, so a trace is never cut in half between the gateway and the API.

**Secrets in the telemetry.** Npgsql spans carry the SQL statement, and logs carry their parameters. The Starter has an integration test that listens to every `ActivitySource` and every log while an organization's AI key goes through the API, and asserts the key appears in none of them. A key in a header or a query string is the usual leak.


## When it is not worth it
For one host with a database, the console logs and `docker compose logs` are often enough, and `AddServiceDefaults` already gives us the dashboard in development for free. A collector is one more container to run, update and size; a hosted backend is one more bill.

The setup pays off when a request crosses processes, through a gateway or a message bus, which is where log lines alone stop telling a story. Even then, start with what the template wires and the OTLP variable, then add a custom span where a question came up twice, not everywhere at once.


## Conclusion
`AddServiceDefaults` wires the three signals, lists the sources and meters to collect, and adds an OTLP exporter only when `OTEL_EXPORTER_OTLP_ENDPOINT` is set. Aspire points it at its dashboard in development; in production, the same variable points it at a collector or a hosted backend. What stays our job is the list: every library integration, every `ActivitySource` and every `Meter` we create must be named there, and each host needs its own `OTEL_SERVICE_NAME` once Aspire no longer sets it.


## References
- [OpenTelemetry .NET](https://opentelemetry.io/docs/languages/dotnet/) — the SDK, its exporters and its instrumentation libraries.
- [.NET Aspire service defaults](https://learn.microsoft.com/dotnet/aspire/fundamentals/service-defaults) — what the generated ServiceDefaults project contains.
- [.NET Aspire telemetry](https://learn.microsoft.com/dotnet/aspire/fundamentals/telemetry) — how the AppHost configures OTLP for each resource.
- [.NET Aspire dashboard](https://learn.microsoft.com/dotnet/aspire/fundamentals/dashboard/overview) — the dashboard, and its standalone mode.
- [Distributed tracing in .NET](https://learn.microsoft.com/dotnet/core/diagnostics/distributed-tracing-instrumentation-walkthroughs) — `ActivitySource` and `Activity`.
- [Creating metrics in .NET](https://learn.microsoft.com/dotnet/core/diagnostics/metrics-instrumentation) — `Meter`, `IMeterFactory` and instrument types.
- [OTLP exporter configuration](https://opentelemetry.io/docs/languages/sdk-configuration/otlp-exporter/) — the `OTEL_EXPORTER_OTLP_*` variables.
- [OpenTelemetry Collector](https://opentelemetry.io/docs/collector/) — the vendor-neutral collector.
