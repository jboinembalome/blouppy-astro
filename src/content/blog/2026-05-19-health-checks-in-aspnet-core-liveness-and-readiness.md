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

A health endpoint is easy to add and easy to get wrong. The usual first version is one `/health` that checks everything, the database included, and answers every question an orchestrator asks. Then the database has a bad minute. Every replica fails its liveness probe, the orchestrator restarts them all, and the outage now includes a cold start of the whole application.

The opposite mistake is just as common: a `/health` that always says `Healthy`, so traffic goes to a host that cannot reach anything.


## Two questions, two endpoints
An orchestrator asks a running process two different things:

- **Liveness**: is this process stuck? A "no" means *restart me*. It should only fail for a fault a restart fixes, such as a deadlock or an exhausted thread pool.
- **Readiness**: can this process serve a request right now? A "no" means *stop sending me traffic*, nothing more. A missing database belongs here.

A third probe, **startup**, holds the other two back while a slow start is in progress.

ASP.NET Core has no built-in notion of these. It has **checks**, each with a name and tags, and **endpoints**, each with a predicate that picks which checks it runs. The probes are a convention built on top:

```csharp
builder.Services.AddHealthChecks()
    .AddCheck("self", () => HealthCheckResult.Healthy(), tags: ["live"])
    .AddNpgSql(connectionString, name: "orders-db", timeout: TimeSpan.FromSeconds(3));

app.MapHealthChecks("/health");

app.MapHealthChecks("/alive", new HealthCheckOptions
{
    Predicate = registration => registration.Tags.Contains("live")
});
```

`/health` has no predicate, so it runs every check. `/alive` runs only those tagged `live`. The overall status is the worst of the checks that ran: `Healthy` and `Degraded` answer `200`, `Unhealthy` answers `503`. An exception thrown inside a check counts as `Unhealthy`. The `timeout` cancels the check's token, so a database that does not answer fails after three seconds instead of holding the probe.


## Liveness never looks outside the process
This is the rule that prevents restart loops. If PostgreSQL is down, restarting the API does not bring it back. It only adds a cold start, a burst of reconnections when the database returns, and, in Kubernetes, a growing back-off.

So `/alive` runs one check, `self`, which always returns `Healthy`. The check proves nothing; the request does. The probe goes through Kestrel, the middleware and the routing, so a process that cannot answer an HTTP request in time fails it. That is exactly the fault a restart fixes.

Readiness runs everything. A host whose database is unreachable answers `503` on `/health`, the load balancer takes it out of rotation, and it comes back by itself when the database does.


## Which dependencies count
For each dependency, ask: *if it is down, should this host stop receiving traffic?*

[Blouppy Starter](https://starter.blouppy.com/) answers it adapter by adapter. Each database context gets a check from Aspire's PostgreSQL integration. The messaging adapter adds a RabbitMQ check: a host that cannot reach the broker publishes into its outbox and consumes nothing. The Redis cache is the deliberate exception. It is an optimization, so its registration sets `DisableHealthChecks = true`: a slower answer beats no answer.

The same reasoning applies to an e-mail server or a payment provider. A check for each makes the host leave rotation for an outage that affects one feature. Report those as `Degraded`, which still answers `200`, or leave them out.

Keep checks cheap, too. They run on every probe, from every source, on every replica. `SELECT 1` or a connection attempt is enough. The Starter's broker check keeps one connection open between probes rather than opening one each time.


## Keep the endpoints in Production, keep them quiet
Aspire's service defaults template maps `/health` and `/alive` only in Development, with a comment about security. As generated, a Production host has no health endpoint at all. The Starter keeps the paths and removes the condition. Trimmed from its `ServiceDefaults`:

```csharp
endpoints.MapHealthChecks("/health", new HealthCheckOptions { ResponseWriter = WriteStatusOnly })
    .AllowAnonymous()
    .DisableRateLimiting();

endpoints.MapHealthChecks("/alive", new HealthCheckOptions
    {
        Predicate = registration => registration.Tags.Contains("live"),
        ResponseWriter = WriteStatusOnly
    })
    .AllowAnonymous()
    .DisableRateLimiting();

static Task WriteStatusOnly(HttpContext context, HealthReport report)
    => context.Response.WriteAsync(report.Status.ToString());
```

`AllowAnonymous()` matters because the API has a fallback authorization policy, and a probe never carries a token. `DisableRateLimiting()` keeps a monitor polling every few seconds from being throttled and reported as down. `WriteStatusOnly` writes one word. The default writer does the same today; writing it out means a change of default can never publish a check's description or exception.

That matters because a detailed health report is an inventory for an attacker: host names, versions, which dependency is failing right now. Details go to the logs and traces. If you need a detailed report, map it on a separate path with `RequireAuthorization()`.


## Who acts on the answer
Docker Compose does not restart an unhealthy container. `restart: unless-stopped` reacts to the process exiting, not to the health status. So the Starter's Compose file points every host's healthcheck at `/health`, with `curl --fail` and a thirty-second `start_period` that plays the role of a startup probe. The result is used for start order, through `depends_on` with `condition: service_healthy`. And `depends_on` only orders the start: once the API is up, Compose does not stop it when Redis fails.

Kubernetes does act on the answer, and there the split is what keeps a database outage from turning into a restart storm:

```yaml
livenessProbe:
  httpGet: { path: /alive, port: 8080 }
  timeoutSeconds: 2
readinessProbe:
  httpGet: { path: /health, port: 8080 }
  timeoutSeconds: 5
startupProbe:
  httpGet: { path: /alive, port: 8080 }
  periodSeconds: 5
  failureThreshold: 30
```

Keep each check's timeout below the probe's `timeoutSeconds`, so a slow dependency reports `Unhealthy` before the probe gives up. And check which path each probe really uses: an orchestrator pointed at `/health` for liveness turns every dependency into a restart condition.

For a single process with no orchestrator, one `/health` with a database check is enough. What is never optional is the one-word body, as soon as the endpoint is reachable from outside.


## References
- [Health checks in ASP.NET Core](https://learn.microsoft.com/aspnet/core/host-and-deploy/health-checks) — Microsoft Learn: `AddHealthChecks`, `MapHealthChecks`, predicates and response writers.
- [.NET Aspire health checks](https://learn.microsoft.com/dotnet/aspire/fundamentals/health-checks) — Microsoft Learn: the service defaults' endpoints and the checks integrations add.
- [Configure liveness, readiness and startup probes](https://kubernetes.io/docs/tasks/configure-pod-container/configure-liveness-readiness-startup-probes/) — Kubernetes: how each probe is acted upon.
- [Control startup order in Compose](https://docs.docker.com/compose/how-tos/startup-order/) — Docker: `depends_on` with `service_healthy`.
