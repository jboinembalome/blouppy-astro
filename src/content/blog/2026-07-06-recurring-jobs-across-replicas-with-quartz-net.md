---
templateKey: 'blog-post'
title: 'Recurring jobs across replicas with Quartz.NET instead of BackgroundService'
date: 2026-07-06T09:00:00.000Z
author: Jimmy Boinembalome
authorimage: /img/jimmy.jpg
category: C#
topic: 'C# & .NET'
illustration: 2
categorycolor: bg-purple-100 text-purple-800
featuredpost: true
description: >-
  Learn why a BackgroundService loop breaks once an ASP.NET Core app runs on several replicas, and how a clustered Quartz.NET scheduler on PostgreSQL runs each job once, on time.
tags:
  - Development
  - C#
  - ASP.NET Core
  - Quartz.NET
---

Every SaaS ends up with work nobody asks for: purge old notifications, delete expired exports, re-queue webhook deliveries whose backoff has elapsed. The first version is nearly always a `BackgroundService` with a `while` loop and a `Task.Delay`. It works on a laptop, and it keeps working in production until the API runs on a second replica.


## What goes wrong with the loop
Here is the loop most of us have written once:

```csharp
internal sealed class NotificationPurge(IServiceScopeFactory scopeFactory) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        while (!stoppingToken.IsCancellationRequested)
        {
            await using var scope = scopeFactory.CreateAsyncScope();

            await scope.ServiceProvider
                .GetRequiredService<INotificationRetentionService>()
                .PurgeExpiredAsync(stoppingToken);

            await Task.Delay(TimeSpan.FromDays(1), stoppingToken);
        }
    }
}
```

None of its problems shows on one machine. It runs on **every replica**: three replicas, three purges a day. For a delete that is waste; for a job that sends e-mails, it is a bug. The schedule restarts from zero on every deployment, so a pod that restarts every few hours may never reach its daily run. And if every replica is down when the job was due, nothing knows it was due.

`PeriodicTimer` fixes the drift, not the rest. What is missing is a shared store that says when each job last ran, and a lock so that only one process acts on it.


## A scheduler with a shared store
[Quartz.NET](https://www.quartz-scheduler.net/) separates a **job** (the code), a **trigger** (when it runs) and a **job store** (where both are kept). With the ADO.NET store, triggers live in database tables. With **clustering** on, every process that shares the scheduler's name is a node of one cluster. Before firing a trigger, a node takes a row lock and marks the trigger as acquired, and the others skip it. Nodes also check in regularly, so the cluster notices one that died.

This is how [Blouppy Starter](https://starter.blouppy.com/) sets it up in its scheduling adapter, trimmed to one job:

```csharp
services.AddQuartz(quartz =>
{
    quartz.ConfigureScheduler(scheduler =>
    {
        scheduler.InstanceName = "blouppy";
        scheduler.GenerateInstanceId = true;
    });

    quartz.UsePersistentStore(store =>
    {
        store.UsePostgres(dataSource => dataSource.ConnectionStringName = ConnectionStringName);
        store.UseClustering(_ => { });
        store.UseSystemTextJsonSerializer(_ => { });
        store.ConfigureStore(options =>
        {
            options.TablePrefix = "quartz.qrtz_";
            options.SchemaProvisioning = SchemaProvisioning.Validate;
        });
    });

    quartz.ScheduleJob<NotificationPurgeJob>(
        trigger => trigger
            .WithIdentity(nameof(NotificationPurgeJob))
            .StartNow()
            .WithSimpleSchedule(schedule => schedule
                .WithInterval(NotificationPurgeJob.Interval)
                .RepeatForever()
                .WithMisfireInstruction(SimpleTriggerMisfireInstruction.NowWithExistingCount)),
        job => job.WithIdentity(nameof(NotificationPurgeJob)));
});

services.AddQuartzHostedService(options => options.WaitForJobsToComplete = true);
```

`InstanceName` is the cluster's identity, so every replica must use the same one. `GenerateInstanceId` gives each process a unique id inside it. The table prefix carries a schema, so Quartz's tables sit in their own `quartz` schema of the application database. `WaitForJobsToComplete` lets a running job finish during a graceful shutdown. One thing Quartz cannot fix: the nodes' clocks must be synchronised, since it compares timestamps written by different machines.


## A job is a thin door
A job injects a driving port and calls it. It decides *when*; the domain decides *what*:

```csharp
[DisallowConcurrentExecution]
internal sealed class NotificationPurgeJob(INotificationRetentionService notificationRetentionService) : IJob
{
    public static readonly TimeSpan Interval = TimeSpan.FromDays(1);

    public async ValueTask Execute(IJobExecutionContext context, CancellationToken cancellationToken = default)
        => await notificationRetentionService.PurgeExpiredAsync(cancellationToken);
}
```

The DI job factory creates a scope for each execution, so the job gets a fresh `DbContext` through the service it calls. There is no `IServiceScopeFactory` in sight. `[DisallowConcurrentExecution]` stops a second execution of the same job while one is still running, and with a clustered store this holds across the cluster. A sweep that takes longer than its interval delays the next fire instead of overlapping it.

The Starter does not leave that attribute to review. A unit test scans the assembly for every `IJob` and fails when one is missing it, in the spirit of [architecture tests that fail the build](/blog/2026-07-03-architecture-tests-that-fail-the-build/).


## Misfires: a run nobody made
A **misfire** is a fire time that passed without the trigger firing, because every node was down or busy. Once a trigger is late by more than a threshold (a minute by default), Quartz applies its **misfire instruction**. The loop could never have this setting, because it never knew a run was due.

The Starter picks the instruction per job. The purges use `NowWithExistingCount`: a missed daily purge runs as soon as a node is back, because data kept past its retention is what we want to avoid. The webhook sweep, every thirty seconds, uses `NextWithRemainingCount`: missed fires are skipped, since replaying a burst of sweeps would only add load at startup. The question for each job is "if this run was missed, do I want it now, or is the next one enough?".

For work tied to the calendar, a **cron trigger** replaces the simple one. Quartz's cron expressions start with a seconds field, so `"0 5 0 * * ?"` is five past midnight. Pin it with `InTimeZone(TimeZoneInfo.Utc)`, or a container with a different `TZ` moves the job.


## The tables are ours
Quartz can create its tables itself. The Starter refuses: `SchemaProvisioning.Validate` makes the scheduler check the tables at startup and never create or alter one. They come from an EF Core migration that embeds Quartz's own PostgreSQL script, applied by the migration runner before the API starts. The consequence is that a Quartz upgrade that changes the schema needs a migration of its own. The startup check fails loudly if the two drift, which is the point.

Two more traps. Triggers are stored by name, so renaming a job class without keeping its identity leaves an old trigger pointing at a type that no longer exists. And the API's integration tests remove `QuartzHostedService`, otherwise the jobs would purge rows underneath the tests.


## When a BackgroundService is still right
[Hangfire](https://www.hangfire.io/) is the other common choice. It has a dashboard and shines at fire-and-forget jobs with retries; Quartz.NET focuses on scheduling. In a codebase that already has a message bus for background work, a scheduler that only decides *when* fits better than a second job queue.

And sometimes neither is needed. The Starter's identity host prunes OpenIddict's expired tokens with a plain `BackgroundService` on a `PeriodicTimer`. Each replica prunes on its own timer, and that is harmless: the delete matches a fixed condition, so a second replica finds nothing left to delete.

The test is simple. If running the job twice, late, or not at all after a restart is harmless, a `BackgroundService` is enough. If any of those is a bug, use a scheduler with a shared store.


## References
- [Quartz.NET documentation](https://www.quartz-scheduler.net/documentation/) — jobs, triggers, job stores and configuration.
- [Quartz.NET clustering](https://www.quartz-scheduler.net/documentation/quartz-3.x/tutorial/advanced-enterprise-features.html) — how a clustered ADO.NET store shares work between nodes.
- [Quartz.NET Microsoft DI integration](https://www.quartz-scheduler.net/documentation/quartz-3.x/packages/microsoft-di-integration.html) — `AddQuartz`, `ScheduleJob` and scoped jobs.
- [Background tasks with hosted services in ASP.NET Core](https://learn.microsoft.com/aspnet/core/fundamentals/host/hosted-services) — Microsoft Learn: `BackgroundService` and scopes.
