---
templateKey: 'blog-post'
title: 'Signals in Angular: computed, linkedSignal and effect'
date: 2026-08-29T09:00:00.000Z
author: Jimmy Boinembalome
authorimage: /img/jimmy.jpg
category: Angular
topic: 'Front end'
illustration: 3
categorycolor: bg-red-100 text-red-800
featuredpost: true
description: >-
  Pick the right signal primitive in Angular 22: signal, computed, linkedSignal or effect, when an effect is the wrong tool, untracked, component signals and equality.
tags:
  - Development
  - Angular
  - TypeScript
---

Angular gives us four ways to hold or react to state with signals: `signal`, `computed`, `linkedSignal` and `effect`. All four compile, and all four can show the right value on the first try. The difference shows later. A value lags one render behind. An effect loops because it reads what it writes. A switch cannot be put back after a failed save.


## Four primitives, one order
A **`signal`** is a value we own and write. A **`computed`** is derived from other signals: lazy, memoized and read-only. A **`linkedSignal`** is derived too, but writable: we can set it, and it resets when its source changes. An **`effect`** derives nothing; it runs code when the signals it read change.

Here they are on an order form:

```ts
const quantity = signal(1);
const unitPrice = signal(12);
const plan = signal({ name: 'Team', includedSeats: 5 });

// Derived, read-only, recomputed only when quantity or unitPrice change.
const total = computed(() => quantity() * unitPrice());

// Follows the plan, but the customer may pick another seat count.
const seats = linkedSignal(() => plan().includedSeats);

// Reaches outside the graph.
effect(() => analytics.track('order-total', total()));
```

Choosing is a short list, in this order:

1. A value nobody else gives us is a `signal`.
2. A function of other signals is a `computed`.
3. A function of other signals that the person may override for a while is a `linkedSignal`.
4. Anything that reaches outside the signal graph (the DOM, the URL, a stream, a third-party API) is an `effect`.

Most component state falls under the first two. In [Blouppy Starter](https://starter.blouppy.com/), the select of the design system writes one signal, the selection, and derives everything else: whether it is disabled, the visible options, the trigger's label. Nothing stores a result, so nothing can drift.


## linkedSignal: put back after a failed save
A settings switch is the typical `linkedSignal`. It shows the server's value. The person flips it, a request goes out, and if the request fails the switch must go back.

A `computed` cannot be flipped. A `signal` started from the server's value does not follow it when the settings load later or another organization opens. `linkedSignal` does both. Here is the Starter's built-in AI switch, trimmed:

```ts
// template: <ui-switch [(checked)]="isBuiltInAiEnabled" (checkedChange)="save($event)" />
public readonly isBuiltInAiEnabled = linkedSignal(() => this.settings.isBuiltInAiEnabled());

public save(isBuiltInAiEnabled: boolean): void {
  this.settings.update(organizationId, { isBuiltInAiEnabled }).subscribe({
    error: () => this.isBuiltInAiEnabled.set(this.settings.isBuiltInAiEnabled()),
  });
}
```

The two-way binding writes the choice at once, so the switch moves before the server answers. On success, the service stores what the server returned, and source and override agree again. On error, the component writes the server's value back.

When the new value depends on the previous one, `linkedSignal` takes `{ source, computation: (source, previous) => … }`. The textbook case is a selected item that must survive a reload of its list while it is still in it.


## When an effect is the wrong tool
An effect that writes a signal from other signals is a `computed` or a `linkedSignal` written the long way. The pattern is common, and the Starter's single sign-on settings have it too:

```ts
// The long way
public readonly enforcedSwitch = signal(false);

constructor() {
  effect(() => {
    const isEnforced = this.connection()?.isEnforced ?? false;
    untracked(() => this.enforcedSwitch.set(isEnforced));
  });
}

// The same, in one line
public readonly enforcedSwitch = linkedSignal(() => this.connection()?.isEnforced ?? false);
```

The effect version works, but it costs three things. An effect does not run when its source is set; Angular schedules it, so anything reading in between sees the old value. A `linkedSignal` is current the moment it is read. A reader must find the effect in the constructor to learn where the field comes from. And without that `untracked`, the effect's own write would schedule it again.

The same goes for "syncing two signals". If B always follows A, B is a `computed`. If B follows A until the person changes it, B is a `linkedSignal`.


## What an effect is for
An effect is for leaving the graph. The Starter's genuine effects all talk to something that is not a signal. `syncQueryParams()` writes a list page's search and page into the URL. Others push an input into an RxJS `Subject`, fill a reactive form, or set up a `MutationObserver` and disconnect it in the cleanup function the effect receives.

An effect depends on every signal it reads, including inside the functions it calls. `untracked(fn)` runs `fn` without recording those reads. So the habit is: read the dependencies on the first lines, then do the work inside `untracked`. The effect re-runs for the reasons we can see, and a helper that starts reading a new signal next year adds no hidden dependency.


## Inputs, equality and zoneless
Component inputs are signals too, which is what lets `computed` and `linkedSignal` derive from them. `input()` is read-only. `model()` is writable and binds both ways with `[(checked)]`. `output()` is not a signal at all, just an emitter. A `model()` saves an input and output pair, but lets the child write the parent's state. When the parent must validate first, keep the pair.

A signal notifies only when the new value differs, by `Object.is`. A new object with the same fields always notifies. An `equal` option changes that, but the Starter declares none. It derives primitives instead, such as `computed(() => this.currentOrganization()?.id ?? null)`, which `Object.is` compares well.

All of this is mandatory in a zoneless app. The Starter runs with `provideZonelessChangeDetection()`, so Angular re-renders when a signal read by a template changes, not after every promise or HTTP response. A plain field set in a `subscribe` changes, and the screen does not show it. The rule is short: **state read by a template is a signal**. The [visual review of the app](/blog/2026-08-14-visual-review-for-an-angular-app-with-playwright/) is where a page that forgot one shows up stuck.


## When not to bother
Constants stay plain: a guide URL that never changes needs no signal. A stream stays a stream when it needs `switchMap`, debouncing or cancellation; the effect only feeds it. And a value the person edits for a long time, such as a whole form, reads better as a reactive form with an explicit `reset()` than as a `linkedSignal` hiding the reset in a declaration.


## References
- [Signals overview](https://angular.dev/guide/signals) — Angular: `signal`, `computed`, `effect`, `untracked` and equality.
- [Dependent state with linkedSignal](https://angular.dev/guide/signals/linked-signal) — Angular: the shorthand and the `source`/`computation` forms.
- [Accepting data with input properties](https://angular.dev/guide/components/inputs) — Angular: `input()`, `input.required()` and `model()`.
- [Zoneless](https://angular.dev/guide/zoneless) — Angular: what schedules change detection without Zone.js.
