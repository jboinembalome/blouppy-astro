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

For years, an Angular template refreshed "by magic": a timer fired, a promise resolved, an HTTP response arrived, and the screen followed. The magic was zone.js, a library that patches the browser's asynchronous APIs so that Angular knows when our code might have changed something.

Zoneless change detection removes it. Angular stops guessing and waits to be told. Most code keeps working. Some code silently stops updating the screen, with no error.


## What zone.js did
zone.js wraps `setTimeout`, `Promise.then`, `addEventListener`, `XMLHttpRequest` and most other asynchronous APIs. When a callback finishes and the zone settles, Angular runs a change detection pass over the whole tree. So this component works with zone.js, although nothing tells Angular that `message` changed:

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

The patched `setTimeout` runs the callback, Angular checks every binding and sees the new text. The price is that the same happens after *every* callback, including a `mousemove` listener in a chart library or a polling timer that changed nothing.


## What tells Angular to refresh now
With `provideZonelessChangeDetection()`, Angular schedules a pass only when something notifies it:

- a signal read by a template is set;
- `ChangeDetectorRef.markForCheck()` is called, which `AsyncPipe` does when its observable emits;
- an input changes, through a template binding or `ComponentRef.setInput()`;
- a listener bound in a template or a host binding runs, such as `(click)`;
- a view is attached, for instance a dialog.

Several notifications in the same turn give one pass. Anything else schedules nothing: a `setTimeout`, a `fetch`, a native `addEventListener`, a library callback. The greeting, written for zoneless, keeps its state in a signal:

```ts
export class GreetingComponent {
  public readonly message = signal('Loading…');

  constructor() {
    setTimeout(() => this.message.set('Hello'), 1000);
  }
}
```

The timer is not patched any more, and it does not need to be: `set` is the notification.

Zoneless was experimental in Angular 18, became stable as `provideZonelessChangeDetection` in Angular 20.2, and is the default for new projects since Angular 21.


## A library that knows nothing about Angular
The front end of [Blouppy Starter](https://starter.blouppy.com/) does not even install zone.js. Its toast timer and its server-sent events stream follow the greeting's rule: the callback writes a signal, and the screen follows. No component injects `ChangeDetectorRef`.

The rich-text editor was the instructive case. It wraps tiptap, whose state is not a signal, and its toolbar asks the editor `isActive('bold')` straight from the template. The first version only copied the current heading level into a signal on tiptap's events. A click on the toolbar's Bold button refreshed the view, since a template listener ran. Ctrl+B or a paste did not: the mark changed, nothing notified Angular, and the button stayed inactive. The fix is a revision counter that every tiptap event bumps, and that `isActive` reads (simplified):

```ts
private readonly _editorState = signal(0);

constructor() {
  effect(onCleanup => {
    const editor = this.editor();
    const sync = () => this._editorState.update(revision => revision + 1);

    editor.on('transaction', sync);
    onCleanup(() => editor.off('transaction', sync));
  });
}

public isActive(name: string): boolean {
  this._editorState();

  return this.editor().isActive(name);
}
```

Reading the signal makes the template depend on it. The value itself is meaningless; only the change matters.


## What breaks
Nothing fails at build time or throws at runtime. A binding simply stays stale until something else triggers a pass, which makes these bugs look random. The usual suspects:

- **A plain field written in a callback**: a `subscribe`, a `ResizeObserver`, a library event. The fix is a signal, or `toSignal()` for an observable.
- **State that only looks reactive.** `FormArray.controls` is not a signal. The Starter's webhook form keeps its header rows in a signal next to the form for that reason.
- **A parent reading a child's value.** A change inside a child's view marks the child for check, not its ancestors. A parent showing `form.value` must read `valueChanges` through `toSignal()`.
- **Libraries that wait for `NgZone.onStable`.** Without zone.js, it never emits. Angular's replacements are `afterNextRender` and `afterEveryRender`.

To find stale bindings in development, `provideCheckNoChangesConfig({ exhaustive: true, interval: 1000 })` checks every binding on a timer and reports the ones that changed without a notification. It is a debugging aid, not a production setting.


## Migrating and testing
An `OnPush` component already refreshes only on inputs, template events, `markForCheck` and signals, which is almost the zoneless list. So the order that keeps an app working is: make components `OnPush`-compatible, move template state to signals, replace `onStable`, then switch the provider. Remove `zone.js` from the `polyfills` of both the build and the test target last.

Tests change too. `fakeAsync`, `tick` and `waitForAsync` are built on zone.js and go with it. `fixture.whenStable()` waits for pending work such as an `HttpClient` request. The test runner's fake timers replace `tick`: the Starter's toast specs call `vi.advanceTimersByTime(1000)`, then render with `ApplicationRef.tick()`.

Unit tests rarely catch a stale binding when they call `fixture.detectChanges()`, because it forces the pass the real app would never run. The spec that holds the toolbar fix does the opposite. It toggles bold through the editor's own commands, waits with `whenStable()` and checks the button: without the revision signal, it fails.


## Is it worth it?
The gains are concrete: no polyfill in the bundle, native `async`/`await` instead of downlevelled generators, stack traces without `ZoneDelegate` frames, and no pass for a callback that changed nothing.

A new app has no reason to load zone.js, and an app already on `OnPush` and signals migrates in an afternoon. A large app with default change detection and plain fields mutated in subscriptions is a different project. There, `OnPush` and signals are worth adopting first, for their own sake. Zoneless then comes at the end, as a one-line change.


## References
- [Angular without ZoneJS](https://angular.dev/guide/zoneless) — angular.dev: enabling zoneless, the notifications, testing.
- [Signals](https://angular.dev/guide/signals) — angular.dev: `signal`, `computed` and `effect`.
- [`provideCheckNoChangesConfig`](https://angular.dev/api/core/provideCheckNoChangesConfig) — angular.dev: finding bindings that changed without a notification.
- [Tiptap events](https://tiptap.dev/docs/editor/api/events) — the `transaction` event the toolbar listens to.
