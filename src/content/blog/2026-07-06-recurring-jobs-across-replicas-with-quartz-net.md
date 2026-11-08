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

Every SaaS ends up with work nobody asks for: purge old notifications, delete expired data exports, re-queue webhook deliveries whose backoff has elapsed. The first version is nearly always a `BackgroundService` with a `while` loop and a `Task.Delay`. It works on a laptop, and it keeps working in production until the API runs on a second replica.

In this article, we will look at what goes wrong with that loop, then replace it with a clustered Quartz.NET scheduler that keeps its state in PostgreSQL: the job store, `[DisallowConcurrentExecution]`, misfire instructions, simple and cron triggers, scoped dependencies and the tables, created by a migration. We will finish with Hangfire and with the cases where a plain `BackgroundService` is still the right tool.


## The problem with a BackgroundService loop
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

It has four problems, and none of them shows on a single developer machine:

- **It runs on every replica.** Three replicas means three purges a day. For a delete with a fixed condition that is only wasteful; for a job that sends e-mails, it is a bug.
- **The timing drifts.** The next run is "one day after the previous one finished", so the schedule slides by the duration of each run, and it restarts from zero on every deployment.
- **Nothing remembers the last run.** A pod that restarts every few hours may never reach its daily run.
- **Missed runs are lost.** If every replica is down when the job was due, nothing knows it was due.

`PeriodicTimer` fixes the drift, not the rest. The missing pieces are a shared store that says when each job last ran and when it is due next, and a lock so that only one process acts on it.


## The idea: a scheduler with a shared store
[Quartz.NET](https://www.quartz-scheduler.net/) separates three things: a **job** (the code, an `IJob`), a **trigger** (when it runs) and a **job store** (where both are kept). With the default in-memory store, Quartz is a better timer. With the ADO.NET store, triggers live in database tables, and with **clustering** turned on, every process that shares the same scheduler name becomes one node of a cluster: before firing a trigger, a node takes a row lock in the `locks` table, marks the trigger as acquired, and the others skip it. Each node also checks in regularly, so the cluster notices a node that died and recovers what it was doing.

A minimal setup with the Microsoft DI integration looks like this:

```csharp
services.AddQuartz(quartz =>
{
    quartz.ConfigureScheduler(scheduler =>
    {
        scheduler.InstanceName = "my-app";
        scheduler.GenerateInstanceId = true;
    });

    quartz.UsePersistentStore(store =>
    {
        store.UsePostgres(dataSource => dataSource.ConnectionStringName = "app-db");
        store.UseClustering(_ => { });
        store.UseSystemTextJsonSerializer(_ => { });
    });

    quartz.ScheduleJob<NotificationPurgeJob>(trigger => trigger
        .WithIdentity(nameof(NotificationPurgeJob))
        .StartNow()
        .WithSimpleSchedule(schedule => schedule
            .WithInterval(TimeSpan.FromDays(1))
            .RepeatForever()));
});

services.AddQuartzHostedService(options => options.WaitForJobsToComplete = true);
```

- `InstanceName` is the cluster's identity: every replica must use the same one. `GenerateInstanceId` gives each process a unique id inside it.
- `AddQuartzHostedService` starts and stops the scheduler with the host. `WaitForJobsToComplete` lets a running job finish during a graceful shutdown.
- The clocks of the nodes must be synchronised. Quartz compares timestamps written by different machines, so a node whose clock is off misjudges what is due.


## The real example: one scheduling adapter
[Blouppy Starter](https://starter.blouppy.com/) is built on [hexagonal architecture](/blog/2026-05-04-hexagonal-architecture-in-dotnet/), and the scheduler is an adapter like any other: `Blouppy.Infrastructure.Scheduling`. Its rule is short: **every recurring job is a Quartz.NET `IJob` in `Jobs/`, registered with its trigger in `AddScheduling`; a module that needs a job adds it here, never a `BackgroundService`**.

The store's location is declared once:

```csharp
namespace Blouppy.Infrastructure.Scheduling;

internal static class SchedulerStore
{
    public const string Schema = "quartz";

    public const string TablePrefix = $"{Schema}.qrtz_";

    // Every replica uses this name, which is what makes them one cluster.
    public const string InstanceName = "blouppy";
}
```

The table prefix carries the schema, so Quartz's tables sit in their own `quartz` schema of the application database, next to the application's tables and away from them. Here is `AddScheduling`, trimmed to two jobs:

```csharp
public IServiceCollection AddScheduling()
{
    services.AddQuartz(quartz =>
    {
        quartz.ConfigureScheduler(scheduler =>
        {
            scheduler.InstanceName = SchedulerStore.InstanceName;
            scheduler.GenerateInstanceId = true;
        });

        // The tables come from a migration: the scheduler checks them and never creates or alters any.
        quartz.UsePersistentStore(store =>
        {
            store.UsePostgres(dataSource => dataSource.ConnectionStringName = ConnectionStringName);
            store.UseClustering(_ => { });
            store.UseSystemTextJsonSerializer(_ => { });
            store.ConfigureStore(options =>
            {
                options.TablePrefix = SchedulerStore.TablePrefix;
                options.SchemaProvisioning = SchemaProvisioning.Validate;
            });
        });

        quartz.ScheduleJob<WebhookDeliverySweepJob>(
            (provider, trigger) => trigger
                .WithIdentity(nameof(WebhookDeliverySweepJob))
                .StartNow()
                .WithSimpleSchedule(schedule => schedule
                    .WithInterval(provider.GetRequiredService<IOptions<WebhookOptions>>().Value.SweepInterval)
                    .RepeatForever()
                    .WithMisfireInstruction(SimpleTriggerMisfireInstruction.NextWithRemainingCount)),
            (_, job) => job.WithIdentity(nameof(WebhookDeliverySweepJob)));

        SchedulePurge<NotificationPurgeJob>(quartz, NotificationPurgeJob.Interval);
    });

    services.AddQuartzHostedService(options => options.WaitForJobsToComplete = true);

    return services;
}
```

The webhook sweep reads its interval (thirty seconds by default) from the bound `WebhookOptions` when the scheduler starts, so options validation reports a bad value before Quartz is handed one. The five purges (webhook deliveries, audit entries, AI usage records, data exports, notifications) share a helper we will see with misfires.


## Jobs are small, scoped and non-concurrent
A job is a thin door into the hexagon. It injects a driving port and calls it:

```csharp
namespace Blouppy.Infrastructure.Scheduling.Jobs;

[DisallowConcurrentExecution]
internal sealed class NotificationPurgeJob(INotificationRetentionService notificationRetentionService) : IJob
{
    public static readonly TimeSpan Interval = TimeSpan.FromDays(1);

    public async ValueTask Execute(IJobExecutionContext context, CancellationToken cancellationToken = default)
        => await notificationRetentionService.PurgeExpiredAsync(cancellationToken);
}
```

- **Constructor injection works, scoped services included.** The Microsoft DI job factory creates a scope for each execution, so the job gets a fresh `DbContext` through the service it calls. There is no `IServiceScopeFactory` in sight, unlike the loop above.
- **`[DisallowConcurrentExecution]`** stops a second execution of the same job from starting while one is still running. With a clustered store, this holds across the cluster: a sweep that takes longer than its interval delays the next fire instead of overlapping it, on any node.
- **The retention rule lives in the domain.** The job decides *when*; `INotificationRetentionService` decides *what*.

The Starter does not leave the attribute to review. `SchedulingRegistrationTests` scans the assembly for every `IJob` and fails when one is missing `[DisallowConcurrentExecution]`, in the spirit of [architecture tests that fail the build](/blog/2026-07-03-architecture-tests-that-fail-the-build/). A sibling test lists the jobs by name, so a job added outside `Jobs/` is noticed too.

A job can also handle the failures it expects. The webhook sweep catches `DbUpdateConcurrencyException`: if a redelivery claimed the same rows first, the batch rolled back, nothing was queued twice, and the sweep logs it at information level and waits for the next fire.


## Misfires: what happens to a run nobody made
A **misfire** is a fire time that passed without the trigger firing: every node was down, or all the scheduler's threads were busy. Once a trigger is late by more than the misfire threshold (a minute by default), Quartz applies the trigger's **misfire instruction**. This is the setting the `BackgroundService` loop could not have, because it never knew a run was due.

The Starter uses two, and the choice follows what the job does:

```csharp
// A purge that missed its run while every replica was down runs once on the next start.
private static void SchedulePurge<TJob>(IQuartzBuilder quartz, TimeSpan interval)
    where TJob : IJob
    => quartz.ScheduleJob<TJob>(
        trigger => trigger
            .WithIdentity(typeof(TJob).Name)
            .StartNow()
            .WithSimpleSchedule(schedule => schedule
                .WithInterval(interval)
                .RepeatForever()
                .WithMisfireInstruction(SimpleTriggerMisfireInstruction.NowWithExistingCount)),
        job => job.WithIdentity(typeof(TJob).Name));
```

- **`NowWithExistingCount`** for the purges: a missed daily purge should run as soon as a node is back. Data kept past its retention is the thing we want to avoid.
- **`NextWithRemainingCount`** for the webhook sweep: the missed fires are skipped and the trigger waits for its next scheduled time. A sweep that runs every thirty seconds has nothing to catch up on, and replaying a burst of missed sweeps would only add load at startup.

The question to ask for each job is "if this run was missed, do I want it now, or is the next one enough?".


## Simple triggers or cron triggers
A **simple trigger** repeats at a fixed interval. It suits a sweep or a purge, where "every hour" matters and "at which minute" does not. A **cron trigger** fires on the calendar. Quartz's cron expressions have a seconds field first, and `?` for "no specific value" in the day-of-month or day-of-week field.

The Starter only needs simple triggers. A project-management app built on the Starter has jobs tied to the calendar, such as one that runs every night at five past midnight:

```csharp
quartz.ScheduleJob<CycleCircuitBreakerJob>(
    trigger => trigger
        .WithIdentity(nameof(CycleCircuitBreakerJob))
        .WithCronSchedule("0 5 0 * * ?", schedule => schedule
            .InTimeZone(TimeZoneInfo.Utc)
            .WithMisfireInstruction(CronTriggerMisfireInstruction.FireAndProceed)),
    job => job.WithIdentity(nameof(CycleCircuitBreakerJob)));
```

`InTimeZone(TimeZoneInfo.Utc)` makes the schedule independent of the server's local time zone, so a container image with a different `TZ` does not move the job. `FireAndProceed` runs a missed night once on the next start, then returns to the calendar.


## The tables come from a migration
Quartz ships SQL scripts for each database, and it can create its tables itself. The Starter refuses that: `SchemaProvisioning.Validate` makes the scheduler check the tables at startup and never create or alter one. The tables come from an EF Core migration of `BlouppyDbContext`, `AddQuartzScheduler`, which embeds Quartz's own PostgreSQL script with the configured prefix:

```csharp
protected override void Up(MigrationBuilder migrationBuilder)
{
    // Quartz.NET's own PostgreSQL schema, with the table prefix the scheduler is configured with.
    // Quartz only validates it at startup, so a Quartz upgrade that changes it needs a migration of its own.
    migrationBuilder.EnsureSchema(name: "quartz");

    migrationBuilder.Sql("""
        CREATE TABLE IF NOT EXISTS quartz.qrtz_job_details (
          sched_name text not null,
          job_name text not null,
          job_group text not null,
          ...
        );
        """);
}
```

The script creates the job details, the triggers (with one table per trigger type: simple, cron, simple-property, blob), the calendars, the fired triggers, the scheduler state used by the cluster's check-ins and the `locks` table. `Blouppy.MigrationRunner` applies it with every other migration before the API starts, so the API never creates a table itself. An integration test migrates a fresh PostgreSQL container, starts a host with `AddScheduling()`, and checks that every job got its trigger with the expected interval: starting at all already proves that the tables match what Quartz validates.


## The costs and the pitfalls
Quartz is not free, and a few things bite:

- **A Quartz upgrade can change the schema.** Since the tables are ours, a new version that changes them needs its own migration. The startup validation fails loudly when the two drift, which is the point of `Validate`.
- **Tests need to switch it off.** In `Blouppy.Web.IntegrationTests`, the jobs would sweep and purge underneath the tests, and the database reset between tests would empty the scheduler's tables. The test host removes `QuartzHostedService`, and the jobs have their own tests.
- **Every node polls the database.** Check-ins and trigger acquisition are regular queries on every replica: small, but not zero.
- **Job identities are part of the contract.** Triggers are stored by name. Renaming a job class without keeping its identity leaves the old trigger in the tables, pointing at a type that no longer exists.


## Quartz.NET, Hangfire or a BackgroundService
[Hangfire](https://www.hangfire.io/) is the other common choice. It has persistent storage, recurring jobs on cron expressions, and a built-in dashboard that shows jobs, retries and failures, which Quartz.NET does not ship. Its strength is fire-and-forget and delayed jobs with automatic retries. The core is licensed under the LGPL, and Hangfire Pro adds paid features on top. Quartz.NET is under the Apache 2.0 licence and focuses on scheduling: triggers, calendars, misfires and clustering. In a codebase that already has a message bus for background work, as the Starter has with [Wolverine](/blog/2026-06-09-replacing-masstransit-with-wolverine/), a scheduler that only decides *when* fits better than a second job queue.

And sometimes neither is needed. A `BackgroundService` remains the right tool for **genuinely per-replica work**: warming a local cache, draining an in-process channel, or a cleanup that is harmless to run on every node. The Starter has one. OpenIddict's token pruning in the identity host is a `BackgroundService` with a `PeriodicTimer`, and its comment says why:

```csharp
// A hosted service rather than a scheduler: each replica prunes on its own timer, and that is harmless.
// The two PruneAsync calls only delete rows matching a fixed condition, so a second replica running the
// same hour finds fewer rows, or none, and deletes nothing it should not.
internal sealed class TokenPruning(
    IServiceScopeFactory scopeFactory,
    TimeProvider timeProvider,
    ILogger<TokenPruning> logger) : BackgroundService
```

The identity host is its own hexagon, without the scheduling adapter, and Quartz for one idempotent delete would cost more than it saves. A project-management app built on the Starter chose otherwise there: OpenIddict's own Quartz integration, on a second clustered scheduler in the same tables. Both are reasonable. The test is simple: if running the job twice, or late, or not at all after a restart is harmless, a `BackgroundService` is enough. If any of those is a bug, use a scheduler with a shared store.


## Conclusion
A `BackgroundService` loop knows nothing outside its own process: not the other replicas, not the last run, not the run it missed. A clustered Quartz.NET scheduler moves that knowledge into PostgreSQL, fires each trigger on one node, and lets us decide per job what a missed run means. In [Blouppy Starter](https://starter.blouppy.com/), all of it sits in one adapter: jobs that call a driving port, a `quartz` schema created by a migration, and tests that hold each job to `[DisallowConcurrentExecution]`.


## References

- [Quartz.NET documentation](https://www.quartz-scheduler.net/documentation/) — the official documentation: jobs, triggers, job stores and configuration.
- [Quartz.NET clustering](https://www.quartz-scheduler.net/documentation/quartz-3.x/tutorial/advanced-enterprise-features.html) — how clustered ADO.NET job stores share work between nodes.
- [Quartz.NET Microsoft DI integration](https://www.quartz-scheduler.net/documentation/quartz-3.x/packages/microsoft-di-integration.html) — `AddQuartz`, `ScheduleJob` and scoped jobs.
- [Quartz.NET cron triggers](https://www.quartz-scheduler.net/documentation/quartz-3.x/tutorial/crontriggers.html) — the cron expression format, seconds field included.
- [Background tasks with hosted services in ASP.NET Core](https://learn.microsoft.com/aspnet/core/fundamentals/host/hosted-services) — Microsoft Learn: `BackgroundService` and scoped services in a hosted service.
- [PeriodicTimer](https://learn.microsoft.com/dotnet/api/system.threading.periodictimer) — the .NET timer used by the token pruning.
- [Hangfire](https://www.hangfire.io/) — the background job library, its dashboard and its licensing.
- [Blouppy Starter](https://starter.blouppy.com/) — the starter kit whose scheduling adapter this article describes.
