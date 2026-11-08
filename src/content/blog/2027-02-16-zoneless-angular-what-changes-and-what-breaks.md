---
templateKey: 'blog-post'
title: 'Zoneless Angular: what changes and what breaks'
date: 2027-02-16T09:00:00.000Z
author: Jimmy Boinembalome
authorimage: /img/jimmy.jpg
category: Angular
topic: 'Front end'
illustration: 3
categorycolor: bg-red-100 text-red-800
featuredpost: true
description: >-
  Learn what zone.js did for Angular, what schedules change detection without it, which code breaks when it goes, how to migrate an app and its tests, and what we gain.
tags:
  - Development
  - Angular
  - TypeScript
---

For years, an Angular template refreshed "by magic": a timer fired, a promise resolved, an HTTP response arrived, and the screen followed. The magic was zone.js, a library that patches every asynchronous API of the browser so that Angular knows when our code might have changed something. It works, but it costs a polyfill in every bundle, noisy stack traces, and refreshes nobody asked for.

Zoneless change detection removes it. Angular stops guessing and waits to be told. Most code keeps working; some code silently stops updating the screen, with no error.

In this article, we will see what zone.js used to do, what tells Angular to refresh without it, what breaks, how to migrate an app and its tests, and what we gain. The examples come from [Blouppy Starter](https://starter.blouppy.com/), whose front-end workspace does not even install zone.js.


## What zone.js used to do
zone.js wraps `setTimeout`, `Promise.then`, `addEventListener`, `XMLHttpRequest` and most other asynchronous browser APIs. Every callback runs inside a zone, and when the zone's queue of microtasks empties, `NgZone` emits `onMicrotaskEmpty` and Angular calls `ApplicationRef.tick()`: a change detection pass over the whole tree.

So this component works with zone.js, although nothing tells Angular that `message` changed:

```ts
@Component({
  selector: 'app-greeting',
  template: `<p>{{ message }}</p>`,
})
export class GreetingComponent {
  public message = 'Loading…';

  constructor() {
    setTimeout(() => (this.message = 'Hello'), 1000);
  }
}
```

The patched `setTimeout` runs the callback, the zone settles, Angular checks every binding and sees the new text. The price is that the same happens after *every* asynchronous callback, including a `mousemove` listener in a chart library or a polling timer that changed nothing.


## What triggers change detection without zone.js
With `provideZonelessChangeDetection()`, Angular schedules a pass only when something notifies it. The notifications are:

- **A signal read by a template is set.** The view that read it is marked for check and a pass is scheduled.
- **`ChangeDetectorRef.markForCheck()`** is called. `AsyncPipe` calls it when its observable emits, so `| async` keeps working.
- **An input changes** through a template binding or `ComponentRef.setInput()`.
- **A listener bound in a template or a host binding runs**: `(click)`, `(keydown.escape)`, `host: { '(document:keydown)': ... }`.
- **A view is attached** to the application, for instance a CDK portal or a dialog.

The passes are coalesced: several notifications in the same turn give one pass. Anything else, a `setTimeout`, a `fetch`, a native `addEventListener` or a callback from a library, schedules nothing.

The greeting above, written for zoneless, keeps its state in a signal:

```ts
export class GreetingComponent {
  public readonly message = signal('Loading…');

  constructor() {
    setTimeout(() => this.message.set('Hello'), 1000);
  }
}
```

The timer is not patched any more, and it does not need to be: `set` is the notification.

The versions moved quickly. Zoneless was experimental in Angular 18 (`provideExperimentalZonelessChangeDetection`), became stable as `provideZonelessChangeDetection` in Angular 20.2, and is the default for new projects since Angular 21.


## The real example: an app with no zone.js at all
In the Starter, the application's providers start with the one line that matters:

```ts
export const appConfig: ApplicationConfig = {
  providers: [
    provideZonelessChangeDetection(),
    provideAnimations(),
    provideRouter(appRoutes, withPreloading(PreloadAllModules)),
    provideI18n(),
    provideAuth(),
  ],
};
```

`zone.js` is not in `polyfills` and not even installed: Angular lists it as an optional peer dependency. The design-system playground declares the same provider. The interesting part is everywhere else, in the places where code outside Angular hands a value back to a template.

**A timer.** The toast stack of `@blouppy/ui` removes a toast when its life runs out. The timer is a plain `setTimeout`; the list is a signal, so the removal reaches the screen:

```ts
@Injectable({ providedIn: 'root' })
export class UiToastService {
  private readonly _toasts = signal<readonly UiShownToast[]>([]);

  public readonly toasts = this._toasts.asReadonly();

  private run(id: number, timing: Timing): void {
    timing.startedAt = Date.now();
    timing.handle = setTimeout(() => this.dismiss(id), timing.remaining);
  }
}
```

**A browser API.** The app's one server-sent events stream, described in [Server-sent events with ASP.NET Core and Angular](/blog/2026-09-13-server-sent-events-with-aspnet-core-and-angular/), uses a raw `EventSource`. Its handlers only write signals:

```ts
// The app is zoneless, so nothing here has to be marshalled onto or off a zone:
// a frame reaches the screen because a listener writes a signal.
this._eventSource = new EventSource(this.buildUrl(), { withCredentials: true });

this._eventSource.onopen = () => {
  this._hasConnected = true;
  this._status.set('open');
};

this._eventSource.onerror = () => this._status.set('reconnecting');
```

With zone.js, the same code would trigger a full pass on every frame, including frames no page cares about. Here a frame nobody's signal depends on costs no render at all.

**A third-party library.** The rich-text editor wraps tiptap, which knows nothing about Angular. The bubble menu subscribes to the editor's own events in an `effect` and copies what the dropdown shows into signals:

```ts
export class UiRichTextEditorBubbleMenuComponent {
  public readonly currentBlock = signal<UiRichTextEditorBlockType>(0);

  constructor() {
    effect(onCleanup => {
      const editor = this.editor();
      const sync = () => {
        const level = ([1, 2, 3] as const).find(candidate => editor.isActive('heading', { level: candidate }));
        this.currentBlock.set(level ?? 0);
      };

      editor.on('selectionUpdate', sync);
      editor.on('transaction', sync);
      onCleanup(() => {
        editor.off('selectionUpdate', sync);
        editor.off('transaction', sync);
      });
    });
  }
}
```

The direction also goes the other way. Tiptap renders some of its nodes as plain DOM, outside any template, so the editor pushes a translated string into them with an `effect` instead of binding it: `effect(() => setMermaidErrorText(this._resolvedLabels().mermaidError))`.

None of these places calls `ChangeDetectorRef`. In the whole Starter front end, no component injects it: a signal does the job of `markForCheck()`, and does it only for the views that read it.


## What breaks
Nothing fails at build time or throws at runtime. A binding simply stays stale until something else happens to trigger a pass, which makes these bugs look random.

**A plain field written outside a template event.** The first greeting component is the typical case: a field mutated in a `setTimeout`, a `subscribe` callback, a `ResizeObserver` or a library callback. The fix is a signal. A `subscribe` that sets a field can also become `toSignal()`.

**State that is not reactive, read by a template.** Reactive forms are the trap here, because a `FormArray` looks like state. The webhook form of the Starter adds and removes header rows, and keeps them in a signal next to the form:

```ts
// A signal because `FormArray.controls` is not reactive in a zoneless template.
public readonly headerRows = signal<readonly HeaderRow[]>([]);
public readonly headerLimitReached = computed(() => this.headerRows().length >= WEBHOOK_HEADER_RULES.maxHeaders);
```

**A parent reading a child's value.** A value that changes inside a child component's view marks that child for check, not its ancestors. A parent that shows `form.value` in its own template will not refresh. The playground's date page reads the control's `valueChanges` as a signal for that reason:

```ts
// The value changes inside the field's own view, and a zoneless app does not
// re-evaluate an ancestor's bindings because a descendant was marked dirty.
protected readonly dueOn = toSignal(this.due.valueChanges, { initialValue: this.due.value });
```

**`ngModel` with a signal.** `ngModel` has no two-way binding to a writable signal. The account preferences page splits it into `[ngModel]="selectedTheme()"` and `(ngModelChange)="selectedTheme.set($event)"`.

**Libraries that relied on zones.** A library that listens to `NgZone.onStable` or `onMicrotaskEmpty` to know when rendering is done gets no event: these observables never emit without zone.js. Angular's own replacements are `afterNextRender` and `afterEveryRender`. A library that mutates its component state in its own callbacks and counts on a zone to render it has the same bug as our greeting. `NgZone.run()` and `runOutsideAngular()` still exist and still run the callback, so code calling them does not crash; it just no longer gains or saves anything.

To find the stale bindings in development, Angular can check for values that changed without a notification on a timer, with `provideCheckNoChangesConfig({ exhaustive: true, interval: 1000 })`. It reports an `ExpressionChangedAfterItHasBeenChecked` error where a binding changed silently. It is a debugging aid; it should not stay in production.


## Migrating an app
The order that keeps an app working at each step:

1. **Make components `OnPush`-compatible first.** An `OnPush` component already refreshes only on inputs, template events, `markForCheck` and signals, which is almost the zoneless list. A component that works under `OnPush` will very likely work zoneless.
2. **Move template state to signals**, starting with fields written in callbacks: subscriptions, timers, observers, third-party events. `toSignal()` covers most `subscribe` blocks.
3. **Replace `NgZone.onStable` and `onMicrotaskEmpty`** with `afterNextRender` or `afterEveryRender`.
4. **Switch the provider** to `provideZonelessChangeDetection()`, and run the app with `provideCheckNoChangesConfig` on for a while.
5. **Remove `zone.js`** from `polyfills` in `angular.json`, for the build *and* the test target, then uninstall it.

Unit tests rarely catch the stale bindings of step 2, because a spec calls `fixture.detectChanges()` and forces the pass that the real app would never run. In the Starter, the one place that looks at the rendered app is a Playwright gallery of every page, described in [Visual review for an Angular app with Playwright](/blog/2026-08-14-visual-review-for-an-angular-app-with-playwright/).


## Testing without zone.js
`fakeAsync`, `tick` and `flush` from `@angular/core/testing` are built on zone.js. Without it, they are gone, and so is `waitForAsync`. Two tools replace them.

**`fixture.whenStable()`** resolves when Angular has nothing pending: no scheduled change detection and no pending task, such as an `HttpClient` request in flight. The select wrappers of the Starter pass their value down through `NgModel`, which writes to the control on a microtask, so a spec has to wait for it:

```ts
export async function writeAndSettle(fixture: ComponentFixture<unknown>, write: () => void): Promise<void> {
  write();
  fixture.detectChanges();
  await fixture.whenStable();
  fixture.detectChanges();
}
```

**The test runner's fake timers** replace `fakeAsync` for timers. The toast specs run on Vitest with `vi.useFakeTimers()`, advance the clock, then render with an explicit `ApplicationRef.tick()`, because the stack lives in a CDK overlay outside any fixture:

```ts
it('Should_take_a_toast_off_screen_when_its_life_runs_out', () => {
  // Arrange
  sut.success('Saved');
  render();

  // Act
  vi.advanceTimersByTime(1000);
  render();
  leave(toasts()[0]);
  render();

  // Assert
  expect(toasts()).toHaveLength(0);
});
```

Here `render()` is `TestBed.inject(ApplicationRef).tick()`. The test reads like the app behaves: the timer fires, a signal changes, one pass renders it.


## What we gain
- **A smaller initial bundle.** The zone.js polyfill is gone from every page load.
- **Native `async`/`await`.** zone.js cannot patch native `async` functions, so a zone-based build has to downlevel them to generators. A zoneless app ships them as written.
- **Readable stack traces.** No `ZoneDelegate.invokeTask` frames between our code and the browser.
- **No monkey-patching.** `setTimeout` is the browser's `setTimeout`. A library that relies on the exact behaviour of a native API, or that checks whether it was patched, behaves as in any other page.
- **Fewer passes.** A `mousemove` listener in a chart, a polling timer or an SSE frame that changes nothing costs nothing.
- **Explicit data flow.** A template refreshes because a signal it reads changed, which is also what we read when we debug it.


## When it is not worth it yet
It depends on the app. A new app has no reason to load zone.js. An existing app built on `OnPush` and signals migrates in an afternoon. A large app with default change detection, plain fields mutated in subscriptions and a component library that relies on `NgZone.onStable` is a different project: every component is a potential stale binding, and nothing reports them except the check-no-changes config and careful review. There, `OnPush` and signals are worth adopting first, for their own sake, and the switch to zoneless comes at the end, when it is a one-line change. If a critical dependency is not zoneless-compatible, staying on zone.js is a reasonable choice.


## Conclusion
zone.js refreshed the screen after any asynchronous callback because it could not know which ones mattered. Zoneless Angular refreshes when it is told: a signal set, an input changed, a template event, `markForCheck`. The code that breaks is the code that relied on the guess, plain fields written in timers, observers and library callbacks, and the fix is nearly always the same: put the state in a signal. In the Starter, that rule covers a toast timer, an `EventSource` and a tiptap editor without a single `ChangeDetectorRef`, and the tests move from `fakeAsync` to `whenStable` and fake timers.


## References
- [Angular without ZoneJS (angular.dev)](https://angular.dev/guide/zoneless) — enabling zoneless, the notifications it relies on, removing the polyfill and testing.
- [Signals (angular.dev)](https://angular.dev/guide/signals) — `signal`, `computed` and `effect`.
- [`toSignal` (angular.dev)](https://angular.dev/api/core/rxjs-interop/toSignal) — reading an observable as a signal.
- [`afterNextRender` (angular.dev)](https://angular.dev/api/core/afterNextRender) — the replacement for `NgZone.onStable` in rendering code.
- [`provideCheckNoChangesConfig` (angular.dev)](https://angular.dev/api/core/provideCheckNoChangesConfig) — finding bindings that changed without a notification.
- [zone.js (GitHub)](https://github.com/angular/angular/tree/main/packages/zone.js) — the library and the APIs it patches.
- [Fake timers (Vitest)](https://vitest.dev/guide/mocking#timers) — `vi.useFakeTimers` and `vi.advanceTimersByTime`.
- [Tiptap events (Tiptap)](https://tiptap.dev/docs/editor/api/events) — the `transaction` and `selectionUpdate` events the bubble menu listens to.
