---
templateKey: 'blog-post'
title: 'Health checks in ASP.NET Core that tell the truth: liveness, readiness and dependencies'
date: 2026-05-19T09:00:00.000Z
author: Jimmy Boinembalome
authorimage: /img/jimmy.jpg
category: C#
topic: 'C# & .NET'
illustration: 3
categorycolor: bg-purple-100 text-purple-800
featuredpost: true
description: >-
  Learn how to split ASP.NET Core health checks into liveness and readiness, which dependencies to check, what to expose in Production and how Docker Compose uses them.
tags:
  - Development
  - C#
  - ASP.NET Core
  - Docker
---

A health endpoint is easy to add and easy to get wrong. The usual first version is one `/health` that checks everything, the database included, and is used for every question an orchestrator asks. Then the database has a bad minute, every replica answers `503` to its liveness probe, the orchestrator restarts them all, and the outage now includes a cold start of the whole application. The opposite mistake is just as common: a `/health` that always says `Healthy`, so traffic is sent to a host that cannot reach anything.

In this article, we will see how ASP.NET Core health checks work, split them into **liveness** and **readiness** with tags and predicates, decide which dependencies belong in them, keep the response free of details in Production, and look at how Docker Compose and orchestrators actually use the answer. The real example is [Blouppy Starter](https://starter.blouppy.com/), which maps both probes in every environment from its Aspire service defaults.


## Liveness, readiness and startup
An orchestrator asks a running process three different things:

- **Liveness**: is this process stuck? A "no" means *restart me*. It should only fail for a fault that a restart fixes: a deadlock, an exhausted thread pool, a corrupted in-memory state.
- **Readiness**: can this process serve a request right now? A "no" means *stop sending me traffic*, and nothing more. A missing database belongs here.
- **Startup**: has this process finished starting? It holds the two other probes back while a slow start (migrations, a cache warm-up) is in progress.

ASP.NET Core has no built-in notion of these three. It has **checks**, each with a name and tags, and **endpoints**, each with a predicate that picks which checks it runs. The three probes are a convention we build on top.


## The building blocks
`AddHealthChecks()` registers the health check service and returns a builder. Every check is an `IHealthCheck`, or a delegate for the simple ones:

```csharp
builder.Services.AddHealthChecks()
    .AddCheck("self", () => HealthCheckResult.Healthy(), tags: ["live"])
    .AddCheck<OrdersDatabaseHealthCheck>("orders-db", timeout: TimeSpan.FromSeconds(3));
```

A custom check returns `Healthy`, `Degraded` or `Unhealthy`, and an exception thrown inside it counts as `Unhealthy`:

```csharp
internal sealed class OrdersDatabaseHealthCheck(NpgsqlDataSource dataSource) : IHealthCheck
{
    public async Task<HealthCheckResult> CheckHealthAsync(
        HealthCheckContext context,
        CancellationToken cancellationToken = default)
    {
        await using var command = dataSource.CreateCommand("SELECT 1");
        await command.ExecuteScalarAsync(cancellationToken);

        return HealthCheckResult.Healthy();
    }
}
```

`MapHealthChecks` then maps an endpoint. Without a `Predicate`, it runs every registered check; with one, only those that match:

```csharp
app.MapHealthChecks("/health");

app.MapHealthChecks("/alive", new HealthCheckOptions
{
    Predicate = registration => registration.Tags.Contains("live")
});
```

The overall status is the worst of the checks that ran. By default, `Healthy` and `Degraded` answer `200`, `Unhealthy` answers `503`, and the body is the status as plain text. `HealthCheckOptions.ResultStatusCodes` changes that mapping, and `ResponseWriter` changes the body.

Two details matter in practice. The `timeout` of a registration cancels the token passed to that check, so a database that does not answer becomes `Unhealthy` after three seconds instead of holding the probe until the orchestrator's own timeout. And the checks run when the endpoint is called, in parallel: a probe every ten seconds from three sources means three database round trips every ten seconds, per replica.


## Liveness must not look at dependencies
The rule that prevents restart loops: **a liveness check never depends on something outside the process**. If PostgreSQL is down, restarting the API does not bring it back. It only adds a cold start, a burst of reconnections when the database returns, and, in Kubernetes, a growing back-off before the pod comes back at all.

So the liveness endpoint runs one check, `self`, which always returns `Healthy`. The check itself proves nothing; the request does. The probe goes through Kestrel, the middleware pipeline and the routing, so a process that cannot answer an HTTP request in time fails it. That is exactly the fault a restart fixes.

Readiness, on the other hand, runs everything. A host whose database is unreachable answers `503` on `/health`, the load balancer takes it out of rotation, and it comes back by itself when the database does.


## The real example: Aspire service defaults
In an Aspire solution, the `ServiceDefaults` project is where every host gets its telemetry, resilience and health checks. Aspire's template maps `/health` and `/alive` inside an `if (app.Environment.IsDevelopment())`, with a comment warning that health endpoints outside development have security implications. The consequence is that, as generated, a Production host has no health endpoint at all.

Blouppy Starter keeps the two paths and the `live` tag, and removes the condition. Here is `Blouppy.Aspire.ServiceDefaults/Extensions.cs`, trimmed:

```csharp
public const string ReadinessPath = "/health";

public const string LivenessPath = "/alive";

public const string LiveTag = "live";

public static TBuilder AddDefaultHealthChecks<TBuilder>(this TBuilder builder)
    where TBuilder : IHostApplicationBuilder
{
    builder.Services.AddHealthChecks()
        .AddCheck("self", () => HealthCheckResult.Healthy(), [LiveTag]);

    return builder;
}

public static IEndpointRouteBuilder MapDefaultEndpoints(this IEndpointRouteBuilder endpoints)
{
    endpoints.MapHealthChecks(ReadinessPath, new HealthCheckOptions { ResponseWriter = WriteStatusOnly })
        .AllowAnonymous()
        .DisableRateLimiting();

    endpoints.MapHealthChecks(LivenessPath, new HealthCheckOptions
        {
            Predicate = registration => registration.Tags.Contains(LiveTag),
            ResponseWriter = WriteStatusOnly
        })
        .AllowAnonymous()
        .DisableRateLimiting();

    return endpoints;
}

private static Task WriteStatusOnly(HttpContext context, HealthReport report)
{
    context.Response.ContentType = "text/plain; charset=utf-8";

    return context.Response.WriteAsync(report.Status.ToString());
}
```

What each piece is for:

- **Both endpoints exist in every environment.** The API (`Blouppy.Web`), the identity host and the gateway all call `MapDefaultEndpoints()`, so a Production container, a Compose healthcheck or an uptime monitor can ask them.
- **`AllowAnonymous()`** because the API has a fallback authorization policy, and a probe never carries a token. **`DisableRateLimiting()`** because a monitor polling every few seconds from one address must not end up throttled and reported as down.
- **`WriteStatusOnly`** writes `Healthy`, `Degraded` or `Unhealthy` and nothing else. The framework's default writer does the same today; it is written out so that a change of default can never start publishing a check's description or exception.

### Where the dependency checks come from
`AddDefaultHealthChecks` only adds `self`. The dependencies are added by the adapters that use them, through Aspire's client integrations. Each `DbContext` is enriched after its registration, for example the gateway's key ring:

```csharp
builder.Services.AddDbContext<GatewayDbContext>(options => options
    .UseNpgsql(builder.Configuration.GetConnectionString(GatewayDbContext.ConnectionName)));

// The context's health check, retries and telemetry; /health is not ready without the key ring.
builder.EnrichNpgsqlDbContext<GatewayDbContext>();
```

`EnrichNpgsqlDbContext` from `Aspire.Npgsql.EntityFrameworkCore.PostgreSQL` registers a `DbContext` check (it asks the context whether it can connect) unless its settings disable it. The API enriches `BlouppyDbContext` and the billing module's `BillingDbContext`, the identity host its `ApplicationDbContext`. None of these checks is tagged `live`, so they run on `/health` and never on `/alive`.

Redis is the deliberate exception. The response cache is an optimization, so its integration turns the check off:

```csharp
// No health check: the cache is an optimization, never a dependency, so a Redis outage must not
// take the API out of its load balancer's rotation through /health.
builder.AddRedisDistributedCache(CacheConnectionName, settings => settings.DisableHealthChecks = true);
```

That is the question to ask for each dependency: *if it is down, should this host stop receiving traffic?* For the database the API cannot serve anything without, yes. For a cache, a slower answer is better than no answer. RabbitMQ sits in between: Wolverine's transactional outbox keeps outgoing messages in PostgreSQL until the broker is back, so a broker outage delays messages without failing requests. No broker check is registered in the hosts' code.

Two tests pin the behaviour. `DefaultEndpointsTests` builds a host in `Production` with a failing `database` check whose description contains an internal address, and asserts that `/health` answers `503` with the body `Unhealthy`, nothing more, while `/alive` still answers `200`. `HealthEndpointsTests` calls both paths through the API's whole pipeline without a token and expects `Healthy`. If you want to go further in this direction, the [architecture of ports and adapters](/blog/2026-05-04-hexagonal-architecture-in-dotnet/) is why each adapter brings its own check rather than one central list.


## What to expose publicly
A detailed health report is an inventory for an attacker: database host names, versions, which dependency is failing right now. Two rules keep it safe:

- **The public answer is the status alone.** Details go to the logs and the traces, where the people who need them already look.
- **If a detailed report is needed**, map it on a separate path that requires authorization, or on a port that is not published, with `RequireHost`:

```csharp
app.MapHealthChecks("/health/details", new HealthCheckOptions { ResponseWriter = WriteDetailedJson })
    .RequireAuthorization("Operators");
```

In the Starter's deployment, Caddy forwards everything on the application's domain to the gateway, so `https://app.example.com/health` is reachable from the internet. That is intended, for an uptime monitor, and safe because the body is one word.


## How Docker Compose uses them
`deploy/docker-compose.yml` declares one healthcheck for the three .NET hosts, as a YAML anchor:

```yaml
x-healthcheck: &healthcheck
  test: ["CMD", "curl", "--fail", "--silent", "--output", "/dev/null", "http://127.0.0.1:8080/health"]
  interval: 15s
  timeout: 5s
  retries: 5
  start_period: 30s
```

The runtime image installs `curl` for this probe and nothing else. `--fail` turns a `503` into a non-zero exit code, and `start_period` gives the host thirty seconds during which failures do not count, which plays the role of a startup probe. PostgreSQL, RabbitMQ and Redis have their own native checks (`pg_isready`, `rabbitmq-diagnostics -q ping`, `redis-cli ping`), and the dependencies are expressed with conditions:

```yaml
api:
  healthcheck: *healthcheck
  depends_on:
    migrations:
      condition: service_completed_successfully
    rabbitmq:
      condition: service_healthy
    redis:
      condition: service_healthy
```

Two facts about Compose are easy to miss:

- **`depends_on` only orders the start.** Once the API is up, Compose does not stop it when Redis becomes unhealthy, and the API must survive that on its own.
- **Docker does not restart an unhealthy container.** `restart: unless-stopped` reacts to the process exiting, not to the health status. Pointing the Compose healthcheck at the readiness endpoint is therefore harmless: an unhealthy host is reported, and the gateway, which waits for `web` with `condition: service_healthy`, starts in the right order.

Kubernetes is different, because it does act on the answer. There, the split is what keeps a database outage from turning into a restart storm:

```yaml
livenessProbe:
  httpGet: { path: /alive, port: 8080 }
  periodSeconds: 10
  timeoutSeconds: 2
readinessProbe:
  httpGet: { path: /health, port: 8080 }
  periodSeconds: 10
  timeoutSeconds: 5
startupProbe:
  httpGet: { path: /alive, port: 8080 }
  periodSeconds: 5
  failureThreshold: 30
```

Keep each check's own timeout below the probe's `timeoutSeconds`, so that a slow dependency reports `Unhealthy` before the probe itself gives up.


## Pitfalls and costs
- **One endpoint for everything.** If an orchestrator uses `/health` as its liveness probe, every dependency check becomes a restart condition. Check which path each probe really uses.
- **Checks that are too expensive.** A check runs on every probe, from every source. `SELECT 1` or a connection attempt is enough; a query over a large table is not a health check.
- **A dependency that should not fail readiness.** Adding a check for every integration, the email server, a payment provider, a cache, makes the host leave rotation for outages that only affect one feature. Use `Degraded` for those, which still answers `200`, or no check at all.
- **Middleware in the way.** HTTPS redirection, authorization, rate limiting or a host filter can turn a probe into a `307`, a `401` or a `429`. The probe goes through the same pipeline as everything else, so test it through that pipeline.


## When the simple version is enough
For a single process on one machine, with no orchestrator and nobody polling, the two-endpoint split brings little: one `/health` with a database check, used by an uptime monitor, tells us what we need. Docker Compose alone does not restart on health either, so the liveness distinction only starts to pay off once something acts on the answer, a Kubernetes cluster, a cloud load balancer, a container service that replaces unhealthy instances. What is never optional is the status-only body: as soon as the endpoint is reachable from outside, it should say one word.


## Conclusion
A health check tells the truth when each endpoint answers one question. `/alive` asks whether the process responds and is the only answer that should trigger a restart. `/health` asks whether the host can serve traffic, so it includes the dependencies the host cannot work without, and leaves out the ones, like a cache, that only make it faster. Both stay mapped in Production, anonymous, outside the rate limiter, and they answer with the status alone.

This is how the hosts of [Blouppy Starter](https://starter.blouppy.com/) are probed, from Aspire in development to Docker Compose in production.

## References
- [Health checks in ASP.NET Core (Microsoft Learn)](https://learn.microsoft.com/aspnet/core/host-and-deploy/health-checks) — `AddHealthChecks`, `MapHealthChecks`, predicates, tags and response writers.
- [.NET Aspire health checks (Microsoft Learn)](https://learn.microsoft.com/dotnet/aspire/fundamentals/health-checks) — the `/health` and `/alive` endpoints of the service defaults and the checks client integrations add.
- [.NET Aspire service defaults (Microsoft Learn)](https://learn.microsoft.com/dotnet/aspire/fundamentals/service-defaults) — what the `ServiceDefaults` project template contains.
- [Configure liveness, readiness and startup probes (Kubernetes)](https://kubernetes.io/docs/tasks/configure-pod-container/configure-liveness-readiness-startup-probes/) — how each probe is acted upon.
- [Compose file reference: healthcheck (Docker)](https://docs.docker.com/reference/compose-file/services/#healthcheck) — `test`, `interval`, `timeout`, `retries` and `start_period`.
- [Control startup order in Compose (Docker)](https://docs.docker.com/compose/how-tos/startup-order/) — `depends_on` with `service_healthy` and `service_completed_successfully`.
- [Hexagonal architecture in .NET](/blog/2026-05-04-hexagonal-architecture-in-dotnet/) — why each adapter registers its own pieces, health check included.
