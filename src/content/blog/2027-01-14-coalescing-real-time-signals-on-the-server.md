---
templateKey: 'blog-post'
title: 'Coalescing on the server: one re-read for a burst of real-time signals'
date: 2027-01-14T09:00:00.000Z
author: Jimmy Boinembalome
authorimage: /img/jimmy.jpg
category: C#
topic: 'Architecture'
illustration: 1
categorycolor: bg-purple-100 text-purple-800
featuredpost: true
description: >-
  Learn how to coalesce bursts of real-time signals in ASP.NET Core: debounce vs throttle, a small keyed coalescer on TimeProvider, its tests with FakeTimeProvider, and when to skip it.
tags:
  - Development
  - C#
  - Design Patterns
  - ASP.NET Core
---

A real-time board tells every reader when something changes, and the reader re-reads. That works well for one write. It works less well when someone reorders a column card by card, or an import commits forty issues in a row: every reader on the board receives forty signals and fires forty reads, each one returning almost the same page as the one before.

In this article, we will look at **coalescing**: letting a burst of signals through as one or two. We will separate debounce from throttle with a timeline, write a minimal keyed coalescer in C#, then read the one a project-management app built on the Starter runs on its delivery side, with its tests on a fake clock. We will finish with the Rx operators that do the same job, the costs, and when sending every signal is the better choice.


## Where the idea comes from
Coalescing is not a Gang of Four pattern, and it has no single author. It borrows from three places.

- **Debouncing** comes from electronics. A mechanical switch does not close cleanly: its contacts bounce for a few milliseconds, and a naive circuit reads one press as several. A debounce circuit waits for the signal to settle before reporting it. User interfaces took the word for the same idea: wait until the user stops typing before searching.
- **Throttling** is the other UI classic: run a handler at most once per interval, however often the event fires, like a scroll listener.
- **Request coalescing** and **batching** come from servers. A cache that receives ten concurrent misses for the same key can fetch it once and answer all ten, which is what stampede protection in `HybridCache` does. A writer can gather small writes into one batch.

What they share: many triggers that mean the same thing are folded into fewer actions, keyed by what they are about.

This only works when the triggers are interchangeable. In our case they are, because a signal carries no data: it says "this changed, read it again". The [server-sent events article](/blog/2026-09-13-server-sent-events-with-aspnet-core-and-angular/) explains that rule. Two signals for the same board ask for the same re-read, so dropping one of them loses nothing as long as a later one still arrives.


## Debounce, throttle, leading and trailing edges
The vocabulary is easy to mix up, so here is one burst seen by four strategies. Four signals arrive for the same board at 0, 100, 200 and 300 ms, then nothing. The window is 500 ms.

| Strategy | Delivers at | What the reader sees |
| --- | --- | --- |
| Debounce (trailing edge) | 800 ms | The final state, but only after the burst stops plus the window. |
| Throttle, leading edge only | 0 ms | The first change at once, and the last three are never read. |
| Sample every 500 ms | 500 ms | The final state on a fixed tick, so even a lone write waits. |
| Throttle, leading and trailing edges | 0 ms and 500 ms | The first change at once, and the final state at the window's close. |

The **leading edge** is the first trigger of a burst; the **trailing edge** is the moment the window closes. Each row fails in its own way:

- Pure debounce delays a lone write by the whole window. Worse, a steady stream, one signal every 100 ms for a minute, would deliver nothing until the stream stops.
- Leading-only throttle is fast, but it can drop the signal that describes the final state, and the reader stays on a stale page.
- Sampling adds latency to every write, including the lone one.

The last row keeps a lone write instant and guarantees the final state is read. It is the one we want.


## A minimal keyed coalescer
Before the real code, here is the shape with nothing else around it. A window opens per key. The first call goes through at once. Calls inside an open window only mark it pending. When the window closes, a pending window sends once and starts a new window; a quiet one is removed.

```csharp
public sealed class Coalescer<TKey>(Func<TKey, Task> send, TimeSpan window, TimeProvider timeProvider)
    where TKey : notnull
{
    private readonly Lock _gate = new();
    private readonly Dictionary<TKey, OpenWindow> _windows = [];

    public Task SendAsync(TKey key)
    {
        lock (_gate)
        {
            if (_windows.TryGetValue(key, out var open))
            {
                open.Pending = true;

                return Task.CompletedTask;
            }

            var opened = new OpenWindow();
            _windows[key] = opened;
            opened.Timer = timeProvider.CreateTimer(_ => Close(key), state: null, window, Timeout.InfiniteTimeSpan);
        }

        return send(key);
    }

    private void Close(TKey key)
    {
        lock (_gate)
        {
            var open = _windows[key];

            if (!open.Pending)
            {
                _windows.Remove(key);
                open.Timer?.Dispose();

                return;
            }

            open.Pending = false;
            open.Timer?.Change(window, Timeout.InfiniteTimeSpan);
        }

        _ = send(key);
    }

    private sealed class OpenWindow
    {
        public bool Pending { get; set; }

        public ITimer? Timer { get; set; }
    }
}
```

Three details matter. The leading send happens **outside the lock**, so a slow transport never blocks other keys. The timer comes from `TimeProvider`, so a test can move time by hand. And the trailing send is fire-and-forget: it runs on a timer thread, with no caller to report a failure to. This version does not catch a failure there, which is the first thing the real one fixes.


## The real one: `ServerEventCoalescer`
The project-management app built on the Starter pushes `board.changed` and `issue.changed` signals on a topic per project, `project:{id}`. Its coalescer is the shape above with three changes: the key is the topic and the event name, it holds back the last `ServerEvent` rather than a flag, and it logs a trailing delivery that fails.

```csharp
internal sealed class ServerEventCoalescer(
    IServerEventDelivery delivery,
    TimeProvider timeProvider,
    ILogger<ServerEventCoalescer> logger)
{
    internal static readonly TimeSpan Window = TimeSpan.FromMilliseconds(500);

    private readonly Lock _gate = new();
    private readonly Dictionary<(string Topic, string EventName), OpenWindow> _windows = [];

    public Task DeliverAsync(ServerEventTopic topic, ServerEvent @event, CancellationToken cancellationToken = default)
    {
        var key = (topic.ToString(), @event.Name);

        lock (_gate)
        {
            if (_windows.TryGetValue(key, out var open))
            {
                open.HeldBack = @event;

                return Task.CompletedTask;
            }

            var window = new OpenWindow(topic);
            _windows[key] = window;
            window.Timer = timeProvider.CreateTimer(_ => Close(key), state: null, Window, Timeout.InfiniteTimeSpan);
        }

        return delivery.DeliverAsync(topic, @event, cancellationToken);
    }

    private async Task DeliverHeldBackAsync(ServerEventTopic topic, ServerEvent @event)
    {
        try
        {
            await delivery.DeliverAsync(topic, @event, CancellationToken.None);
        }
        catch (Exception exception)
        {
            // Off any message, so nothing would retry it; the reader catches up on its next read.
            logger.LogWarning(exception, "Could not deliver {EventName} on {Topic}", @event.Name, topic);
        }
    }
}
```

`Close` is the minimal version's, with the held-back event in place of `Pending`. It clears the event and re-arms the timer before delivering, so a signal that arrives while the trailing one goes out waits for the next window instead of being lost. While signals keep coming, one window follows the last: a steady stream reaches the readers once at the start, then once per 500 ms, never more.

The 500 ms is a judgement call, written as such in the code: short enough to read as live, long enough to fold a drag's or an import's writes into one re-read.

### Where it sits: the delivery side
Publishing a signal goes onto the bus, and every replica runs a consumer on a queue of its own, so every replica receives every signal. That consumer, `ServerEventBroadcastConsumer`, calls the coalescer instead of the transport:

```csharp
internal sealed class ServerEventBroadcastConsumer(
    ServerEventCoalescer coalescer,
    ILogger<ServerEventBroadcastConsumer> logger) : IMessageConsumer<ServerEventBroadcastDto>
{
    public async Task ConsumeAsync(ServerEventBroadcastDto message, ConsumedMessage delivery, CancellationToken cancellationToken)
    {
        if (!ServerEventTopic.TryParse(message.Topic, out var topic) || topic is null)
        {
            return;
        }

        try
        {
            await coalescer.DeliverAsync(topic, new ServerEvent(message.EventName, message.Data), cancellationToken);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            logger.LogWarning(ex, "Could not deliver {EventName} on {Topic}", message.EventName, message.Topic);
        }
    }
}
```

The coalescer then calls `IServerEventDelivery`, a port with one method, `DeliverAsync(topic, event)`, which hands a signal to the connections this process holds. The Web implements it over a SignalR hub group.

The class remarks give two reasons for coalescing here rather than when publishing. First, each replica only sees the writes it made itself when it publishes, whereas on the delivery side it sees the bursts of all replicas, which is what its connected readers actually receive. Second, nothing on the write path waits for a timer: a request that moves a card publishes and returns.

The registration keeps it one per process, since the windows are the state that folds a burst:

```csharp
services
    .AddSingleton<ServerEventCoalescer>()
    .TryAddSingleton(TimeProvider.System);
```

### Tests on a fake clock
`TimeProvider` is what makes this testable. The test project references `Microsoft.Extensions.TimeProvider.Testing` and builds the coalescer with a `FakeTimeProvider`. Its timers only fire when the test calls `Advance`, so a test about a 500 ms window runs in microseconds and never flakes:

```csharp
[Fact]
public async Task Should_hold_a_burst_back_to_one_more_signal_when_the_window_closes()
{
    // Arrange
    for (var i = 0; i < 5; i++)
    {
        await _sut.DeliverAsync(Project, ServerEvent.WithoutData("board.changed"), TestContext.Current.CancellationToken);
    }

    // Act
    _timeProvider.Advance(ServerEventCoalescer.Window);

    // Assert
    _delivered
        .Should()
        .BeEquivalentTo(["project:12 board.changed", "project:12 board.changed"]);
}
```

The same file pins the other rules: a lone signal goes at once, a quiet window delivers nothing more, each topic and each name get a window of their own, a steady stream is capped at one per window, and a trailing delivery that throws does not escape the timer callback.


## The browser debounces too
The Angular side adds a second, smaller fold. `followProjectChanges` in `live-project.ts` drops the project's cached queries as soon as a signal arrives, so a revisit never paints stale data, then schedules the re-read with a plain 300 ms trailing debounce (`setTimeout`, reset on each signal). It also waits while the reader is dragging or editing, then re-reads once. The two layers do different jobs: the server bounds what goes over the wire per topic, and the page folds what is left, including a `board.changed` and a reconnection arriving close together.


## The library alternative: Rx
[Rx.NET](https://github.com/dotnet/reactive) (`System.Reactive`) ships these operators. The names need care:

- `Throttle(TimeSpan)` in Rx.NET is a **trailing debounce**: it drops an element followed by another within the duration. Other libraries call this debounce.
- `Sample(TimeSpan)` emits the latest element once per interval, if one arrived.
- `Buffer(TimeSpan)` emits the elements of each interval as a list, which suits batching writes.

```csharp
signals
    .GroupBy(signal => (signal.Topic, signal.Name))
    .SelectMany(group => group.Sample(TimeSpan.FromMilliseconds(500)))
    .Subscribe(signal => Deliver(signal));
```

That is short, and the test story is good (`TestScheduler`). But none of these is the leading-and-trailing throttle we want; it takes a composition of operators. `GroupBy` keeps a group per key for the life of the subscription unless we bound it. And delivery is asynchronous, which fits awkwardly into `Subscribe`. For one class with one rule, the hand-written version is easier to read. For a pipeline of several time-based steps, Rx pays for itself.


## The costs, and when to send every signal
Coalescing is cheap in lines but not free.

- **Timers and concurrency.** The lock, the leading send outside it, the timer re-armed before the trailing send, the swallowed exception on a timer thread: each is a bug if it is wrong, and none shows in a happy-path demo.
- **Latency on the trailing signal.** The last change of a burst reaches readers up to one window late. For a board, half a second is fine. For a chat message, it is not.
- **Per-replica state.** The windows live in memory, per process. Two replicas fold independently, which is correct here because a reader is connected to one of them, but the state is lost on restart. That is harmless only because a signal carries no data.
- **Harder tests.** Without `TimeProvider`, the tests would sleep and flake. With it, they still need care about what `Advance` triggers.

Send every signal when:

- the signal **carries data** the reader cannot get otherwise, because then dropping one loses something;
- bursts are rare, and readers few, so the extra reads cost nothing worth measuring;
- the reader already folds on its side, and the wire traffic is not the problem;
- every event must be seen in order, as for an audit trail or a chat.

When in doubt, start without it, measure the reads a burst causes, and add the coalescer where the numbers say so.


## Conclusion
Coalescing folds interchangeable triggers into fewer actions. It borrows debounce from electronics and UI, throttle from UI, and request coalescing from servers. For real-time signals, a throttle with both edges keeps a lone write instant and guarantees the final state is read. Placed on the delivery side, it sees every replica's bursts and keeps timers off the write path, and `TimeProvider` with `FakeTimeProvider` makes its rules testable in microseconds. It is safe only because a signal says "re-read" and nothing more.


## References
- [Debouncing and Throttling Explained Through Examples](https://css-tricks.com/debouncing-throttling-explained-examples/) — David Corbacho's visual explanation of debounce, throttle and their edges.
- [ReactiveX: Debounce](https://reactivex.io/documentation/operators/debounce.html) — the debounce operator as the Rx implementations define it.
- [ReactiveX: Sample](https://reactivex.io/documentation/operators/sample.html) — emitting the latest item per interval.
- [dotnet/reactive](https://github.com/dotnet/reactive) — Rx.NET, the `System.Reactive` package.
- [TimeProvider class](https://learn.microsoft.com/dotnet/api/system.timeprovider) — the .NET abstraction over the clock and timers.
- [FakeTimeProvider class](https://learn.microsoft.com/dotnet/api/microsoft.extensions.time.testing.faketimeprovider) — the test clock from `Microsoft.Extensions.TimeProvider.Testing`.
- [HybridCache library in ASP.NET Core](https://learn.microsoft.com/aspnet/core/performance/caching/hybrid) — request coalescing for cache misses, under the name stampede protection.
