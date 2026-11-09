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

A real-time board tells every reader when something changes, and the reader re-reads. That works well for one write. It works less well when someone reorders a column card by card, or an import commits forty issues in a row. Every reader then receives forty signals and fires forty reads, each returning almost the same page as the one before.

**Coalescing** lets a burst through as one or two signals.


## Why it is safe to drop signals
Coalescing folds many triggers that mean the same thing into fewer actions, keyed by what they are about. The word comes from servers: a cache that gets ten concurrent misses for one key can fetch it once and answer all ten. Debounce and throttle, its cousins from UI code, do the same with time.

It only works when the triggers are interchangeable. Here they are, because a signal carries no data. It says "this changed, read it again", a rule the [server-sent events article](/blog/2026-09-13-server-sent-events-with-aspnet-core-and-angular/) explains. Two signals for the same board ask for the same re-read. Dropping one loses nothing, as long as a later one still arrives.


## Debounce or throttle
The vocabulary is easy to mix up, so here is one burst seen four ways. Four signals arrive for one board at 0, 100, 200 and 300 ms, then nothing. The window is 500 ms.

| Strategy | Delivers at | What the reader sees |
| --- | --- | --- |
| Debounce (trailing edge) | 800 ms | The final state, but only once the burst stops, plus the window. |
| Throttle, leading edge only | 0 ms | The first change at once; the last three are never read. |
| Sample every 500 ms | 500 ms | The final state on a fixed tick, so even a lone write waits. |
| Throttle, leading and trailing edges | 0 ms and 500 ms | The first change at once, and the final state when the window closes. |

Pure debounce delays a lone write by the whole window. Worse, a steady stream would deliver nothing until it stops. Leading-only throttle can drop the signal that describes the final state, leaving the reader on a stale page. Sampling makes every write wait.

The last row keeps a lone write instant and guarantees the final state is read. That is the one we want.


## A keyed coalescer
A window opens per key. The first call goes through at once. Calls inside an open window only mark it pending. When the window closes, a pending one sends once and starts a new window; a quiet one is removed.

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

Three details matter. The leading send happens **outside the lock**, so a slow transport never blocks other keys. `Close` re-arms the timer before the trailing send, so a signal that arrives meanwhile waits for the next window instead of being lost. A steady stream thus goes out once at the start, then once per window. And the timer comes from `TimeProvider`, so a test can move time by hand.

One thing is missing: the trailing send runs on a timer thread, with no caller to report a failure to. A real version catches and logs it there.


## In a real app
A project-management app built on [Blouppy Starter](https://starter.blouppy.com/) runs this shape as its `ServerEventCoalescer`. The key is a topic, such as `project:12`, plus an event name. It holds back the last event rather than a flag, and it logs a trailing delivery that fails. The window is 500 ms: short enough to feel live, long enough to fold a drag's or an import's writes into one re-read. It is a singleton, since its windows are the state that folds a burst.

Where it sits matters more than how it works. Publishing a signal goes onto the bus, and every replica consumes every signal on a queue of its own. The coalescer runs in that consumer, on the delivery side, not when publishing. There, each replica sees the bursts of all replicas, which is what its readers actually receive. And nothing on the write path waits for a timer: a request that moves a card publishes and returns.

The tests build the coalescer with a `FakeTimeProvider`, whose timers only fire when the test calls `Advance`:

```csharp
for (var i = 0; i < 5; i++)
{
    await _sut.DeliverAsync(Project, ServerEvent.WithoutData("board.changed"), TestContext.Current.CancellationToken);
}

_timeProvider.Advance(ServerEventCoalescer.Window);

_delivered.Should().BeEquivalentTo(["project:12 board.changed", "project:12 board.changed"]);
```

Five signals, one leading and one trailing. A test about a 500 ms window runs in microseconds and never flakes. The same file pins the other rules: a lone signal goes at once, each topic gets its own window, and a failing trailing delivery does not escape the timer.

The browser folds too, with a plain 300 ms trailing debounce before it re-reads. The two layers do different jobs. The server bounds what goes over the wire; the page folds what is left.

[Rx.NET](https://github.com/dotnet/reactive) has operators for this, but with care over names: its `Throttle` is a trailing debounce, and none of them is the leading-and-trailing throttle without composing several. For one class with one rule, the hand-written version reads better.


## When to send every signal
Coalescing costs a lock and timers, and each detail above is a bug if wrong. The last change of a burst arrives up to one window late: fine for a board, not for a chat message. And the windows live in memory, per process, which is harmless only because a signal carries no data.

So send every signal when it **carries data** the reader cannot get otherwise, when every event must be seen in order, or when bursts are rare and readers few. When in doubt, start without it, measure the reads a burst causes, and add the coalescer where the numbers say so.


## References
- [Debouncing and Throttling Explained Through Examples](https://css-tricks.com/debouncing-throttling-explained-examples/) — David Corbacho's visual explanation of the edges.
- [TimeProvider class](https://learn.microsoft.com/dotnet/api/system.timeprovider) — Microsoft Learn: the .NET abstraction over the clock and timers.
- [FakeTimeProvider class](https://learn.microsoft.com/dotnet/api/microsoft.extensions.time.testing.faketimeprovider) — Microsoft Learn: the test clock.
- [Server-Sent Events with ASP.NET Core and Angular](/blog/2026-09-13-server-sent-events-with-aspnet-core-and-angular/) — why a signal carries no data.
