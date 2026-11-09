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

[OpenTelemetry](https://opentelemetry.io/docs/languages/dotnet/) fixes this with three signals that share one context: **traces** (what happened, across processes), **metrics** (how often, how long) and **logs**, with the trace id attached. In .NET, the APIs are already in the runtime: `ActivitySource`, `Meter` and `ILogger`. OpenTelemetry collects and exports them. Aspire's `AddServiceDefaults` wires most of it, and the rest is a list we have to keep.


## What AddServiceDefaults wires
The Aspire template generates a `ServiceDefaults` project that every host references and calls with `builder.AddServiceDefaults()`. Besides health checks, service discovery and resilience, it calls `ConfigureOpenTelemetry`. Here it is in [Blouppy Starter](https://starter.blouppy.com/), trimmed of its comments:

```csharp
builder.Logging.AddOpenTelemetry(logging =>
{
    logging.IncludeFormattedMessage = true;
    logging.IncludeScopes = true;
});

builder.Services.AddOpenTelemetry()
    .WithMetrics(metrics => metrics
        .AddMeter(builder.Environment.ApplicationName)
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
```

Logs go through an OpenTelemetry logger provider, so every line written inside a request carries its trace id. Metrics come from ASP.NET Core, `HttpClient`, the runtime and every meter listed with `AddMeter`. Traces come from ASP.NET Core, `HttpClient` and every source listed with `AddSource`.

The lists are the important part. Libraries create sources and meters whether or not anyone listens. OpenTelemetry subscribes **only to the names we give it**, so an unlisted one exports nothing. Wolverine names its meter after the service, hence the wildcard. MailKit's names come from its own `Telemetry` class.

`AddOpenTelemetryExporters` adds one OTLP exporter for the three signals, and only when `OTEL_EXPORTER_OTLP_ENDPOINT` is set. Without it, the host logs to the console and nothing else changes. That is what lets the same binary run under Aspire, in a test and in a container.


## The dashboard, for free
In development, we never set that variable by hand. When the AppHost starts a project, it injects the variables that point it at the Aspire dashboard, and `OTEL_SERVICE_NAME` set to the resource name. A request through the gateway then shows as one trace: the API's request under it, the SQL commands and the Wolverine spans it caused, across hosts.

The SQL spans come from Aspire client integrations rather than from the list above. Each `DbContext` keeps its own `AddDbContext`, then calls `builder.EnrichNpgsqlDbContext<BlouppyDbContext>()`, which adds Npgsql's tracing, metrics and a health check. Redis works the same way through `AddRedisDistributedCache`.


## Our own spans and metrics
The libraries tell us that a SQL command took 40 ms. They cannot tell us that an export took ten seconds because a customer has 300 orders. That is what our own `ActivitySource` and `Meter` are for. In a generic shop:

```csharp
internal sealed class OrderExportBuilder(IOrdersRepository ordersRepository, IMeterFactory meterFactory)
{
    public const string Name = "Shop.Exports";

    private static readonly ActivitySource Source = new(Name);

    private readonly Counter<long> _exports = meterFactory.Create(Name).CreateCounter<long>("shop.exports");

    public async Task<IReadOnlyList<Order>> BuildAsync(CustomerId customerId, CancellationToken cancellationToken)
    {
        using var activity = Source.StartActivity("export.orders");

        var orders = await ordersRepository.ListByCustomerAsync(customerId, cancellationToken);

        activity?.SetTag("export.orders.count", orders.Count);
        _exports.Add(1, new KeyValuePair<string, object?>("outcome", "success"));

        return orders;
    }
}
```

`StartActivity` returns `null` when nothing listens, hence the `?.`. The span becomes a child of whatever is current, the request or the message handler, without passing anything around. `IMeterFactory`, added in .NET 8, gives a meter owned by the container, which plays well with tests.

Then `Shop.Exports` goes into both lists. The template's `ApplicationName` entry only covers a source named after the host's assembly. In a hexagonal solution, the work happens in domain projects with other names, and each one must be listed. A shared prefix and a wildcard (`AddSource("Shop.*")`) keep the list short.

Keep metric tags bounded. `outcome` has two values. A user id as a tag creates one time series per user, and backends bill per series. High-cardinality values belong on spans and logs.


## A meter nobody listened to
The Starter fell into the list trap once. The identity host counts sign-ins and consents (`tokenservice.user_login`, `tokenservice.consent`) on a meter named after its assembly. At first, no `AddMeter` named it: the counters were incremented and never exported. Nothing failed, which was the problem. The fix is the `AddMeter(builder.Environment.ApplicationName)` line above, the twin of the `AddSource` line the template already had. Check each custom name in the dashboard once.


## Exporting in production
The Starter's `deploy/` runs everything with Docker Compose and ships **no collector**. The hosts share one `.env` file, where `OTEL_EXPORTER_OTLP_ENDPOINT` is empty by default. Empty, `docker compose logs` is the observability. Set, the hosts export to a hosted backend that accepts OTLP, or to a collector container such as the OpenTelemetry Collector. The .NET exporter defaults to gRPC on port 4317; an HTTP-only backend needs `OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf` and port 4318.

Outside Aspire, nobody sets the service name. The SDK would fall back to `unknown_service`, and the hosts would be impossible to tell apart. Since the `.env` file is shared, each host sets its own name in its `environment:` block:

```yaml
api:
  environment:
    <<: *dotnet-environment
    OTEL_SERVICE_NAME: blouppy-api
```

The identity host, the gateway and the migration runner do the same, with Aspire's resource names.

Two more things to watch once data leaves the machine. The default sampler records every trace; a `ParentBasedSampler` over a `TraceIdRatioBasedSampler(0.1)` keeps one in ten without cutting a trace in half between hosts. And telemetry can leak secrets: the Starter has an integration test that listens to every source and every log while an organization's AI key goes through the API, and asserts the key appears in none of them.

For one host with a database, console logs are often enough. The setup pays off when a request crosses processes, through a gateway or a bus, which is where log lines alone stop telling a story.


## References
- [OpenTelemetry .NET](https://opentelemetry.io/docs/languages/dotnet/) — the SDK, its exporters and its instrumentation libraries.
- [.NET Aspire telemetry](https://learn.microsoft.com/dotnet/aspire/fundamentals/telemetry) — what ServiceDefaults wires and how the AppHost configures OTLP.
- [Creating metrics in .NET](https://learn.microsoft.com/dotnet/core/diagnostics/metrics-instrumentation) — `Meter`, `IMeterFactory` and instrument types.
- [End-to-end tests with Aspire.Hosting.Testing](/blog/2026-09-25-end-to-end-tests-with-aspire-hosting-testing/) — the same AppHost graph, under test.
