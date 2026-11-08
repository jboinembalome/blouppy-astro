---
templateKey: 'blog-post'
title: 'Structured logging in .NET: message templates, scopes and what never to log'
date: 2026-06-06T09:00:00.000Z
author: Jimmy Boinembalome
authorimage: /img/jimmy.jpg
category: C#
topic: 'C# & .NET'
illustration: 3
categorycolor: bg-purple-100 text-purple-800
featuredpost: true
description: >-
  Learn how to write structured logs in .NET with ILogger: message templates, levels and categories, scopes, the LoggerMessage source generator, OpenTelemetry, and what never to log.
tags:
  - Development
  - C#
  - ASP.NET Core
  - Logging
---

Most .NET applications log from day one, and most of their logs are written for a human reading a console. Then the application runs on three replicas, the console is gone, and someone has to answer "how many invitations failed yesterday, and for which organizations?" from lines like `Failed to send invitation to bob@example.com: SMTP timeout`. The answer is a full-text search, and the line has just written an e-mail address into a store that nobody planned to erase.

In this article, we will write **structured** logs with the plain `ILogger` of `Microsoft.Extensions.Logging`: message templates instead of interpolated strings, levels and categories, scopes, the `[LoggerMessage]` source generator, and export through OpenTelemetry. Then we will look at what a log must never contain, and at when Serilog is still worth adding.


## Message templates, not strings
A structured log entry is a message **and** a set of named values. `ILogger` gets both from a message template:

```csharp
logger.LogWarning("Invitation {InvitationId} is not pending (current status: {Status})", invitation.Id, invitation.Status);
```

The placeholders are matched to the arguments **by position**, and their names become properties of the entry. A provider that understands structure (OpenTelemetry, Seq, Application Insights) stores `InvitationId` and `Status` as fields, so we can filter on `Status = Revoked` without a regular expression. A console provider simply renders the message.

The interpolated version looks the same in a console and loses all of that:

```csharp
// Don't: the template is a different string on every call.
logger.LogWarning($"Invitation {invitation.Id} is not pending (current status: {invitation.Status})");
```

- **The properties are gone.** The provider receives one finished string, with no `InvitationId` to filter on.
- **Every entry has its own template**, so a backend that groups entries by template sees thousands of "different" messages.
- **The string is built even when the level is off.** Interpolation runs before `LogWarning` is called, so a `LogDebug($"...")` in a hot path allocates in Production, where Debug is filtered out.

The .NET analyzers flag this with [CA2254](https://learn.microsoft.com/dotnet/fundamentals/code-analysis/quality-rules/ca2254): the template should be a constant expression. The same goes for `+` concatenation and `string.Format`.

Two conventions keep templates useful: name placeholders in PascalCase like properties (`{UserId}`, not `{0}` or `{user id}`), and keep the same name for the same thing everywhere, so one query finds every entry about a user.


## Levels and categories
Every entry has a level (`Trace`, `Debug`, `Information`, `Warning`, `Error`, `Critical`) and a **category**. With `ILogger<T>`, the category is the full name of `T`, and configuration filters by category prefix:

```json
"Logging": {
  "LogLevel": {
    "Default": "Information",
    "Microsoft": "Warning",
    "Microsoft.Hosting.Lifetime": "Information"
  }
}
```

That is the whole configuration of the API in [Blouppy Starter](https://starter.blouppy.com/). The framework is quiet unless something goes wrong; our own code logs at Information and above.

A simple rule for picking the level: `Error` when a request or a message failed and someone may have to act, `Warning` when the system degraded but carried on, `Information` for a business fact we want to count, `Debug` for what only helps while debugging. The Starter's notification dispatcher shows all three in a few lines: `LogDebug` when quiet hours hold an e-mail back, `LogWarning` when the recipient no longer exists, and `LogError` when the mail server fails, with a comment explaining why it does not rethrow.


## Scopes
Some values belong to every entry written during a piece of work: the request, the message being handled, the job run. Passing them to every call is noisy. A **scope** attaches them once:

```csharp
using (logger.BeginScope(new Dictionary<string, object?>
{
    ["OrderId"] = order.Id,
    ["TenantId"] = order.TenantId
}))
{
    logger.LogInformation("Charging {Amount}", order.Total);
    await paymentGateway.ChargeAsync(order, cancellationToken);
    logger.LogInformation("Charged");
}
```

Both entries carry `OrderId` and `TenantId`, and so does anything logged by the code we call inside the `using`, even through another logger. Scopes flow with the async context.

A scope only reaches the output if the provider is told to include it. The Starter's `ServiceDefaults`, shared by every host, turns it on for OpenTelemetry:

```csharp
builder.Logging.AddOpenTelemetry(logging =>
{
    logging.IncludeFormattedMessage = true;
    logging.IncludeScopes = true;
});
```

The Starter itself never calls `BeginScope` outside its test helpers, and that is a reasonable default. ASP.NET Core already opens a scope per request (with `RequestId` and `RequestPath`), and OpenTelemetry stamps each log record with the trace and span ids of the current `Activity`. What a scope would add is usually the identifier of the business object, and the Starter puts it in the message template instead, where it is also readable.


## The LoggerMessage source generator
`LogInformation` and friends are extension methods taking `params object?[]`: value types are boxed and the template is parsed (and cached) at run time. For a hot path, and for messages we want to identify precisely, .NET has a [compile-time logging source generator](https://learn.microsoft.com/dotnet/core/extensions/logger-message-generator). We declare a `partial` method, and the generator writes a strongly typed implementation that checks `IsEnabled` first:

```csharp
internal sealed partial class OrderService(ILogger<OrderService> logger)
{
    public void Ship(Order order)
    {
        // ...
        LogOrderShipped(order.Id, order.Lines.Count);
    }

    [LoggerMessage(Level = LogLevel.Information, Message = "Order {OrderId} shipped with {LineCount} lines")]
    private partial void LogOrderShipped(int orderId, int lineCount);
}
```

The generator finds the `ILogger` in a field or, as here, in the primary constructor. A `static` method takes the logger as its first parameter instead. The parameter names must match the placeholders, and a mismatch is a compile-time diagnostic rather than a silently empty property.

The Starter uses it for messages that matter most. Its tool catalog, which serves the MCP server and the in-app assistant, records each tool call:

```csharp
// Never the arguments nor what the tool answered: they hold what people wrote.
LogToolCalled(
    name,
    result.IsError ? "refused" : "succeeded",
    Stopwatch.GetElapsedTime(started).TotalMilliseconds,
    currentUserService.UserId.Value,
    toolCaller.TokenId,
    result.OrganizationId?.Value);

[LoggerMessage(
    Level = LogLevel.Information,
    Message = "Tool {ToolName} {ToolOutcome} in {ElapsedMilliseconds} ms for user {UserId} with token {TokenId} in organization {OrganizationId}")]
private partial void LogToolCalled(
    string toolName,
    string toolOutcome,
    double elapsedMilliseconds,
    string userId,
    string? tokenId,
    int? organizationId);
```

Every value is an identifier, a name or a number: enough to count calls per tool, per token or per organization, and nothing a person typed.

The other use is startup warnings for a half-configured deployment, each with a stable `EventId` so an alert can match it. A hosted service writes this one when no Redis connection string is set:

```csharp
[LoggerMessage(
    EventId = 9301,
    Level = LogLevel.Warning,
    Message = "{Application} has no response cache: the connection string {ConnectionName} is not set, so every read goes "
              + "to the database. Set ConnectionStrings:{ConnectionName} to the Redis server the replicas share.")]
private static partial void ResponseCacheDisabled(ILogger logger, string application, string connectionName);
```

The cost is ceremony: a method per message, a `partial` class. Most of the Starter's code still calls `logger.LogInformation("...", ...)` directly, and that is fine. The generator pays off on hot paths and on messages that someone will search for by id.


## Export with OpenTelemetry
`ILogger` decides what is written; a provider decides where it goes. With the OpenTelemetry provider above, the log records leave the process over OTLP, next to the traces and metrics. The Starter's `ServiceDefaults` calls `UseOtlpExporter()` only when `OTEL_EXPORTER_OTLP_ENDPOINT` is configured, so a host started on its own keeps the default console output and exports nothing.

Under Aspire, the AppHost sets that variable for every project, so the logs of all hosts show up in the dashboard, structured, filterable by property and linked to the trace of the request that wrote them. In Production, the same variable points to any OTLP collector. Tracing deserves its own article, so we stop here.


## What never to log
A log is a copy of data sent to a place with different access rules and a longer life than the database. Four kinds of data should never reach it:

- **Secrets and tokens**: API keys, access and refresh tokens, cookies, `Authorization` headers, connection strings with a password.
- **Personal data**: e-mail addresses, names, IP addresses where they identify someone. A log id (`{RecipientId}`) is enough to investigate, and an account erasure does not have to chase copies through the log store.
- **Request and response bodies**: they hold whatever users typed.
- **Exception messages from third parties**, which often embed one of the above.

The last one is the subtle one. The Starter's Anthropic adapter logs a failed call by **type and status only**, and deliberately drops the SDK's exception:

```csharp
// The type and the status only: the SDK's message carries the response body.
_logger.LogWarning(
    "The Anthropic call failed: {ExceptionType}, status {StatusCode}",
    exception.GetType().Name,
    statusCode is null ? null : (int)statusCode);

// The SDK's exception is not kept as the inner one: its message carries the response body, in which a
// provider may echo the key, and whoever logs an exception writes its inner ones too.
```

Bodies can also leak below our code. `IHttpClientFactory` adds logging handlers to every named client. They log the request URI and status, not bodies, but the Starter removes them on the model provider's client anyway, along with the host's default handlers:

```csharp
services
    .AddHttpClient(AnthropicLlmClient.HttpClientName)
    .ConfigureAdditionalHttpMessageHandlers((handlers, _) => handlers.Clear())
    // What is sent to a provider is the organization's data: no handler logs a request.
    .RemoveAllLoggers()
    .ConfigureHttpClient(client => client.Timeout = Timeout.InfiniteTimeSpan);
```

A rule like this decays unless a test holds it. The Starter's tests plug a `CapturingLoggerProvider` that keeps every formatted message, structured value and full exception, then assert what never reached it. One makes the provider echo the key back in its error body and checks that no entry contains it; another checks that the client's handler chain has no logging handler, against a control client that does.

When logging personal data cannot be avoided, the `Microsoft.Extensions.Compliance.Redaction` and `Microsoft.Extensions.Telemetry` packages add [redaction](https://learn.microsoft.com/dotnet/core/extensions/data-redaction) to `ILogger`: we classify `[LoggerMessage]` parameters with data classification attributes, call `builder.Logging.EnableRedaction()` and `builder.Services.AddRedaction(...)`, and a redactor replaces or hashes the classified values before any provider sees them. The Starter does not use it: it prefers not to pass the value at all, which needs no configuration.

One pitfall the Starter itself still carries: its unhandled-exception handler logs `{Message}` with `exception.Message` and then the exception too. The message is already in the exception, and for a third-party exception it is exactly what we just decided not to log. Passing the exception alone is enough.


## Serilog or plain ILogger
For years, "add Serilog" was the default answer to logging in .NET, because `Microsoft.Extensions.Logging` had no structured backend of its own. With the OpenTelemetry provider, `ILogger` plus an OTLP collector covers what most applications need, and the Starter has no Serilog package at all.

Serilog is still worth adding when:

- **We need a sink OpenTelemetry does not reach**: rolling files on a server with no collector, or a direct write to Seq, Elasticsearch or a database.
- **We want its enrichers**: machine name, thread, environment, values from the `HttpContext`, added to every event by configuration.
- **We want its two-stage bootstrap logger**, which captures a failure that happens before the host is built.

Even then, our code keeps injecting `ILogger<T>`: Serilog plugs in as a provider, so templates, scopes and `[LoggerMessage]` methods all keep working. When none of these needs exists, it is one more package, one more configuration format and one more place where an enricher can add a header we did not want to log.


## Conclusion
Structured logging is mostly discipline with the `ILogger` we already have: constant templates with named placeholders, levels picked for whoever reads them, scopes for the context of a unit of work, and `[LoggerMessage]` where performance or a stable event id matters. OpenTelemetry carries the result to the Aspire dashboard or any collector without a third-party library. The harder part is deciding what stays out: identifiers instead of personal data, types and status codes instead of third-party messages, no bodies, and a test that fails when one slips through.

This is how logging works in [Blouppy Starter](https://starter.blouppy.com/), whose adapters follow the [hexagonal architecture](/blog/2026-05-04-hexagonal-architecture-in-dotnet/) described earlier on this blog.


## References
- [Logging in .NET (Microsoft Learn)](https://learn.microsoft.com/dotnet/core/extensions/logging) — `ILogger`, categories, levels, configuration and scopes.
- [Compile-time logging source generation (Microsoft Learn)](https://learn.microsoft.com/dotnet/core/extensions/logger-message-generator) — the `[LoggerMessage]` attribute and its rules.
- [CA2254: Template should be a static expression (Microsoft Learn)](https://learn.microsoft.com/dotnet/fundamentals/code-analysis/quality-rules/ca2254) — the analyzer rule against interpolated templates.
- [Data redaction in .NET (Microsoft Learn)](https://learn.microsoft.com/dotnet/core/extensions/data-redaction) — classification attributes and redactors for logs.
- [.NET observability with OpenTelemetry (Microsoft Learn)](https://learn.microsoft.com/dotnet/core/diagnostics/observability-with-otel) — the OpenTelemetry logging provider and OTLP export.
- [Aspire dashboard overview (Microsoft Learn)](https://learn.microsoft.com/dotnet/aspire/fundamentals/dashboard/overview) — where the structured logs show up in development.
- [Message Templates](https://messagetemplates.org/) — the template syntax shared by `ILogger` and Serilog.
- [Serilog](https://serilog.net/) — the structured logging library, its sinks and enrichers.
