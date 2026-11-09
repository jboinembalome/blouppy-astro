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

Most .NET applications log from day one, and most of their logs are written for a human reading a console. Then the application runs on three replicas, the console is gone, and someone asks "how many invitations failed yesterday, and for which organizations?". The logs say `Failed to send invitation to bob@example.com: SMTP timeout`. The answer is a full-text search. And the line has just copied an e-mail address into a store nobody planned to erase.


## Message templates, not strings
A structured log entry is a message **and** a set of named values. `ILogger` gets both from a message template:

```csharp
// The template is constant; OrderId and Status become fields of the entry.
logger.LogWarning("Order {OrderId} cannot be shipped (status: {Status})", order.Id, order.Status);

// Don't: one finished string, a different template on every call.
logger.LogWarning($"Order {order.Id} cannot be shipped (status: {order.Status})");
```

The placeholders are matched to the arguments **by position**, and their names become properties. A provider that understands structure (OpenTelemetry, Seq, Application Insights) stores `OrderId` and `Status` as fields, so you can filter on `Status = Cancelled` without a regular expression.

The interpolated version loses all of that. A backend that groups entries by template sees thousands of "different" messages. And the string is built even when the level is off, so a `LogDebug($"...")` in a hot path allocates in Production. The analyzer rule [CA2254](https://learn.microsoft.com/dotnet/fundamentals/code-analysis/quality-rules/ca2254) flags it.

Name placeholders in PascalCase, like properties, and use the same name for the same thing everywhere. Then one query finds every entry about a user.


## Levels, categories, scopes
Every entry has a level and a **category**. With `ILogger<T>`, the category is the full name of `T`, and configuration filters by prefix. [Blouppy Starter](https://starter.blouppy.com/)'s API sets `Default` to `Information` and `Microsoft` to `Warning`: the framework stays quiet unless something goes wrong.

Pick the level for whoever reads it: `Error` when a request or a message failed and someone may have to act. `Warning` when the system degraded but carried on. `Information` for a business fact you want to count. `Debug` for what only helps while debugging.

Some values belong to every entry of a unit of work. `logger.BeginScope(...)` attaches them once, to everything logged inside it, through any logger, across `await`. A scope only reaches the output if the provider includes it; the Starter's service defaults set `IncludeScopes = true` on the OpenTelemetry provider. ASP.NET Core already opens a scope per request, and OpenTelemetry stamps each record with the trace and span ids. So the Starter rarely opens a scope of its own and puts the business id in the template instead, where it is also readable.


## The LoggerMessage source generator
`LogInformation` takes `params object?[]`: value types are boxed and the template is parsed at run time. For a hot path, or a message you want to identify precisely, the [logging source generator](https://learn.microsoft.com/dotnet/core/extensions/logger-message-generator) writes a strongly typed method that checks `IsEnabled` first. The Starter's tool catalog, which serves its MCP server and in-app assistant, records each tool call with one (trimmed here):

```csharp
// Never the arguments nor what the tool answered: they hold what people wrote.
[LoggerMessage(
    Level = LogLevel.Information,
    Message = "Tool {ToolName} {ToolOutcome} in {ElapsedMilliseconds} ms for user {UserId} in organization {OrganizationId}")]
private partial void LogToolCalled(
    string toolName,
    string toolOutcome,
    double elapsedMilliseconds,
    string userId,
    int? organizationId);
```

The generator finds the `ILogger` in a field or the primary constructor. Parameter names must match the placeholders, and a mismatch is a compile-time diagnostic. Every value here is an identifier, a name or a number: enough to count calls per tool or per organization, and nothing a person typed. The cost is ceremony, a method per message.

`ILogger` decides what is written; a provider decides where it goes. The Starter exports through OpenTelemetry over OTLP when `OTEL_EXPORTER_OTLP_ENDPOINT` is set. Under Aspire, that puts every host's logs in the dashboard, filterable by property and linked to the trace that wrote them.


## What never to log
A log is a copy of data sent to a place with other access rules and a longer life than the database. Keep out:

- **Secrets and tokens**: API keys, access tokens, cookies, `Authorization` headers, connection strings with a password.
- **Personal data**: e-mail addresses, names, identifying IP addresses. An id is enough to investigate, and an account erasure does not have to chase copies through the log store.
- **Request and response bodies**: they hold whatever users typed.
- **Third-party exception messages**, which often embed one of the above.

The last one is the subtle one. The Starter's Anthropic adapter logs a failed call by type and status only:

```csharp
// The type and the status only: the SDK's message carries the response body.
_logger.LogWarning(
    "The Anthropic call failed: {ExceptionType}, status {StatusCode}",
    exception.GetType().Name,
    statusCode is null ? null : (int)statusCode);
```

It does not keep the SDK's exception as an inner one either: a provider may echo the key in its error body, and whoever logs an exception writes its inner ones too. The same adapter calls `RemoveAllLoggers()` on its named `HttpClient`, so no handler logs what is sent to the model.

The Starter once had the trap in its own unhandled-exception handler: it logged `{Message}` with `exception.Message`, then the exception. That wrote the message twice, and with it whatever user input it quoted, as a structured field. It now logs the exception under a constant message.

Rules like these decay unless a test holds them. The Starter's tests plug a capturing logger provider and assert what never reached it: one makes the provider echo the key in its error body and checks that no entry contains it. When personal data really must be logged, `Microsoft.Extensions.Compliance.Redaction` adds [redaction](https://learn.microsoft.com/dotnet/core/extensions/data-redaction) to `ILogger`. Not passing the value at all is simpler.


## Serilog or plain ILogger
For years, "add Serilog" was the default, because `Microsoft.Extensions.Logging` had no structured backend. With the OpenTelemetry provider and a collector, plain `ILogger` covers most needs, and the Starter has no Serilog package. Serilog still earns its place for a sink OpenTelemetry does not reach (rolling files, a direct write to Seq), for its enrichers, or for its bootstrap logger that catches a failure before the host is built. Even then, your code keeps injecting `ILogger<T>`: Serilog plugs in as a provider.


## References
- [Logging in .NET](https://learn.microsoft.com/dotnet/core/extensions/logging) — Microsoft Learn: `ILogger`, categories, levels and scopes.
- [Compile-time logging source generation](https://learn.microsoft.com/dotnet/core/extensions/logger-message-generator) — Microsoft Learn: the `[LoggerMessage]` attribute and its rules.
- [.NET observability with OpenTelemetry](https://learn.microsoft.com/dotnet/core/diagnostics/observability-with-otel) — Microsoft Learn: the OpenTelemetry provider and OTLP export.
- [Data redaction in .NET](https://learn.microsoft.com/dotnet/core/extensions/data-redaction) — Microsoft Learn: classification attributes and redactors.
