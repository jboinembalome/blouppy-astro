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

Angular gives us four ways to hold or react to state with signals: `signal`, `computed`, `linkedSignal` and `effect`. All four compile, and all four can make a page show the right value on the first try. The difference shows later: a value that lags one render behind, an effect that loops because it reads what it writes, a switch that cannot be put back after a failed save.

In this article, we will go through the four primitives with a minimal example each, see when an effect is the wrong tool, use `untracked`, look at the component signals `input()`, `model()` and `output()`, touch on equality, and end with why a zoneless app makes all of this mandatory.


## The four primitives
A **`signal`** is a value we own and write. A **`computed`** is a value derived from other signals: it is lazy, memoized, and read-only. A **`linkedSignal`** is derived like a `computed` but writable: we can set it, and it resets to the derived value when its source changes. An **`effect`** derives nothing: it runs code when the signals it read change.

```ts
const quantity = signal(1);
const unitPrice = signal(12);

// Derived, read-only, recomputed only when quantity or unitPrice change.
const total = computed(() => quantity() * unitPrice());

// Derived from the plan, but the person may pick another seat count.
const seats = linkedSignal(() => plan().includedSeats);

// A side effect: talks to something that is not a signal.
effect(() => console.log(`Total is now ${total()}`));
```

A simple way to choose:

1. Is it a value nobody else gives us? `signal`.
2. Can it be written as a function of other signals? `computed`.
3. Is it a function of other signals that the person may override for a while? `linkedSignal`.
4. Does it need to reach outside the signal graph (the DOM, the URL, a stream, a third-party API)? `effect`.

The order matters. Most state in a component falls under the first two, and an `effect` is the last resort.


## computed: most of the state is derived
[Blouppy Starter](https://starter.blouppy.com/) uses `computed` far more than anything else. The select of its design system, `@blouppy/ui/select`, keeps one piece of written state, the selection, and derives the rest:

```ts
@Component({ selector: 'ui-select' /* … */ })
export class SelectComponent<T> {
  public readonly options = input<readonly T[]>([]);
  public readonly multiple = input(false);
  public readonly filter = input(false);
  public readonly disabled = input(false);
  public readonly maxSelectedLabels = input(3);

  protected readonly query = signal('');
  protected readonly selection = signal<readonly unknown[]>([]);
  private readonly _disabledByForm = signal(false);

  protected readonly isDisabled = computed(() => this.disabled() || this._disabledByForm());
  protected readonly hasValue = computed(() => this.selection().length > 0);
  protected readonly counted = computed(() => this.multiple() && this.selection().length >= this.maxSelectedLabels());

  protected readonly visibleOptions = computed(() => {
    const query = this.query().trim().toLowerCase();

    if (!this.filter() || query === '') {
      return this.options();
    }

    return this.options().filter(option => this.labelOf(option).toLowerCase().includes(query));
  });
}
```

- `isDisabled` merges two sources: the `disabled` input and what a reactive form says through `setDisabledState`. Neither can drift from the other, because nothing stores the result.
- `visibleOptions` is recomputed only when the query, the filter flag or the options change. Typing in another field of the form does not touch it.
- `counted` is a rule written once and read by both the trigger's text and its template, so the two cannot disagree.

The same shape, a written value and derived classes and labels, is what the [date input built on `<input type="date">`](/blog/2026-06-03-just-use-input-type-date-in-angular/) uses for its form integration.


## linkedSignal: derived, but the person may override it
Some state is derived until the person touches it. A settings switch is the typical case: it shows the organization's setting, the person flips it, a request goes out, and if the request fails the switch must go back to what the server holds.

A `computed` cannot be flipped. A `signal` initialized from the server value does not follow it when the settings are loaded later or the organization changes. `linkedSignal` does both. This is the built-in AI switch of the Starter's organization settings (trimmed):

```ts
@Component({
  selector: 'app-organization-built-in-ai',
  template: `
    <ui-switch
      [(checked)]="isBuiltInAiEnabled"
      [disabled]="!canManage() || isSaving()"
      (checkedChange)="setBuiltInAi($event)" />
  `,
})
export class OrganizationBuiltInAiComponent {
  private readonly _organizationSettingsService = inject(OrganizationSettingsService);

  /** Follows the organization, and is put back to it when a save fails. */
  public readonly isBuiltInAiEnabled = linkedSignal(() => this._organizationSettingsService.isBuiltInAiEnabled());
  public readonly isSaving = signal(false);

  public setBuiltInAi(isBuiltInAiEnabled: boolean): void {
    this.isSaving.set(true);

    this._organizationSettingsService
      .update(organizationId, { isBuiltInAiEnabled })
      .pipe(takeUntilDestroyed(this._destroyRef))
      .subscribe({
        next: () => this.isSaving.set(false),
        error: () => {
          this.isSaving.set(false);
          this.isBuiltInAiEnabled.set(this._organizationSettingsService.isBuiltInAiEnabled());
        },
      });
  }
}
```

- The service's `isBuiltInAiEnabled` is a `computed` over the settings it loaded. When the settings arrive, or another organization is opened, the switch follows.
- The two-way binding `[(checked)]` writes the person's choice into the linked signal at once: the switch moves before the server answers.
- On success, the service sets the settings the server returned, so the source and the override agree again. On error, the component writes the server's value back.

The API and MCP access selector next to it has the same shape with `linkedSignal<ApiAndMcpAccessLevel | null>(…)`.

When the new value should depend on the previous one, `linkedSignal` takes an object form, `{ source, computation: (source, previous) => … }`. A selected item that must survive a reload of its list, as long as it is still in it, is the textbook use: `computation` returns `previous.value` when it is still there and the first item otherwise.


## When an effect is the wrong tool
An effect that writes a signal from other signals is a `computed` or a `linkedSignal` written the long way. This pattern appears in many code bases, and in the Starter's single sign-on settings too:

```ts
/** What the switch shows: the connection's, unless the person just moved it and has not confirmed yet. */
public readonly enforcedSwitch = signal(false);

constructor() {
  effect(() => {
    const isEnforced = this.connection()?.isEnforced ?? false;

    untracked(() => this.enforcedSwitch.set(isEnforced));
  });
}
```

It works. The `linkedSignal` version says the same in one line:

```ts
public readonly enforcedSwitch = linkedSignal(() => this.connection()?.isEnforced ?? false);
```

What the effect version costs:

- **A render with the stale value.** An effect does not run when its source is set; Angular schedules it. Anything that reads `enforcedSwitch` in between sees the old value. A `linkedSignal` is up to date the moment it is read.
- **Two places to read.** The reader of the class must find the effect in the constructor to learn where the field's value comes from.
- **Loops are one mistake away.** If the effect read `enforcedSwitch()` without `untracked`, its own write would schedule it again.

The same goes for "syncing two signals": if B always follows A, B is a `computed`. If B follows A until the person changes it, B is a `linkedSignal`. Two signals kept equal by an effect each way is a design with one source too many.

An effect that writes a signal is not always wrong, though. The password field of `@blouppy/ui` hides the password again when a form clears it:

```ts
constructor() {
  // A form that clears the field re-masks it.
  effect(() => {
    if (this.value() === '') {
      this.revealed.set(false);
    }
  });
}
```

This could be a `linkedSignal` with `source: this.value` and a `computation` that returns `false` for an empty value and `previous?.value` otherwise. Both are correct; the effect reads as the rule it implements, and a one-tick delay on a hidden password is harmless. This is a judgment call.


## What an effect is for
An effect is for leaving the signal graph. The Starter's genuine effects all talk to something that is not a signal:

```ts
export function syncQueryParams(state: () => Params): void {
  const router = inject(Router);
  const route = inject(ActivatedRoute);

  effect(() => {
    const queryParams = state();

    untracked(() => {
      const current = route.snapshot.queryParamMap;
      const changed = Object.entries(queryParams).some(([key, value]) => (current.get(key) ?? null) !== (value === null ? null : `${value}`));

      if (changed) {
        void router.navigate([], { relativeTo: route, queryParams, queryParamsHandling: 'merge', replaceUrl: true });
      }
    });
  });
}
```

A list page calls `syncQueryParams(() => ({ search: this.search(), page: this.page() }))` and its view lands in the URL. Other effects of the code base push an input into an RxJS `Subject` that a `switchMap` loads from, fill a reactive form when the edited webhook changes, or set up a `MutationObserver` and tear it down through the cleanup function an effect receives:

```ts
effect(cleanup => {
  const listbox = this._listbox()?.nativeElement;

  if (!listbox || !this.filter()) {
    return;
  }

  const observer = new MutationObserver(() => this.activeOptionId.set(listbox.getAttribute('aria-activedescendant')));
  observer.observe(listbox, { attributes: true, attributeFilter: ['aria-activedescendant'] });
  cleanup(() => observer.disconnect());
});
```

The cleanup runs before the next run and when the component is destroyed, so a changed listbox never leaves an observer behind. The [overlays built on the Angular CDK](/blog/2026-07-21-building-overlays-on-the-angular-cdk/) use effects the same way, to write an input into the CDK's own API.


## untracked: choose what an effect depends on
An effect depends on every signal it reads, including the ones read inside functions it calls. `untracked(fn)` runs `fn` without recording those reads. The webhook form states the reason in a comment:

```ts
constructor() {
  // Only the input is tracked: `fill` writes signals the effect would otherwise subscribe to.
  effect(() => {
    const webhook = this.webhook();

    untracked(() => this.fill(webhook));
  });
}
```

The habit is worth keeping: read the dependencies at the top of the effect, then do the work inside `untracked`. The effect then re-runs for the reasons we can see on its first lines, and a helper that starts reading a new signal next year does not quietly add a dependency.

`untracked` also reads a value once without subscribing. The assistant service of the Starter takes the current organization at construction with `untracked(organizationOf)`, then reacts only when it changes to another one.


## input, model and output
Component inputs are signals too, which is what lets `computed` and `linkedSignal` derive from them:

- **`input()`** is a read-only signal. `input.required<number>()` has no default and fails if the parent does not bind it.
- **`model()`** is a writable signal the parent can bind both ways with `[(checked)]`. The `ui-switch` declares `checked = model(false)`: the component sets it on a click, the parent's signal follows, and a reactive form writes it through `writeValue`.
- **`output()`** is not a signal. It returns an emitter with `emit()`, used for events such as the select's `valueChange`.

A `model()` saves the `input` plus `output` pair and the event naming convention. Its cost is that the child writes into the parent's state; for a value the parent must validate before accepting it, an `input` and an `output` keep that decision on the parent's side.


## Equality
A signal notifies its readers only when the new value is different. By default, "different" means `Object.is`: a primitive set to the same value notifies no one, but a new object with the same fields always does. `signal`, `computed` and `linkedSignal` accept an `equal` option to change that:

```ts
const filters = signal<Filters>(initial, {
  equal: (a, b) => a.search === b.search && a.page === b.page,
});
```

We rarely need it. The Starter declares no custom equality and leans on two simpler habits: derive a primitive with `computed(() => this.currentOrganization()?.id ?? null)`, which `Object.is` already compares well, and use `distinctUntilChanged()` when the value goes through RxJS, as the organization settings service does on the organization id. A custom `equal` that ignores a field is a field a reader will one day expect to trigger an update.


## Why zoneless makes this mandatory
The Starter runs with `provideZonelessChangeDetection()`. Without Zone.js, Angular does not re-render after every timer, promise or HTTP response. It re-renders when something tells it to: a signal read by a template changes, a template event listener fires, or `markForCheck` is called.

So a plain field assigned in a `subscribe` callback is set, and the screen does not show it until something else triggers a render. The rule is short: **state read by a template must be a signal**. With that rule, the four primitives are more than a style choice. `isSaving`, `isLoading` and the selection must be signals, everything derived from them must be `computed` or `linkedSignal` to stay reactive, and the [visual review of the app](/blog/2026-08-14-visual-review-for-an-angular-app-with-playwright/) is where a page that forgot one shows up as stuck.


## When not to bother
- **Constants stay plain.** A guide URL, a list of levels, a map of hint keys: `public readonly guideUrl = BUILT_IN_AI_GUIDE_URL` needs no signal, because it never changes.
- **A stream stays a stream** when it needs `switchMap`, debouncing or cancellation. The SSO component loads through a `Subject` and `switchMap` so the answer for an organization the page has left is dropped; the effect only feeds the stream.
- **`linkedSignal` is not free either.** It hides a reset in a declaration. For a value the person edits for a long time, such as a whole form, a reactive form with an explicit `reset()` says more clearly when the server's value wins.


## Conclusion
Most component state is a few `signal`s and many `computed`s. A `linkedSignal` covers the value that follows the server until the person changes it, including the put-back after a failed save. An `effect` is for the edge of the graph: the URL, the DOM, a stream, an observer. When an effect only writes another signal, it is usually a `computed` or a `linkedSignal` waiting to be written, and reading the dependencies first and doing the work in `untracked` keeps the remaining effects predictable.

These patterns come from [Blouppy Starter](https://starter.blouppy.com/), whose front end runs zoneless on Angular 22.

## References
- [Signals overview (Angular)](https://angular.dev/guide/signals) — `signal`, `computed`, `effect`, `untracked` and equality functions.
- [Dependent state with linkedSignal (Angular)](https://angular.dev/guide/signals/linked-signal) — the shorthand and the `source`/`computation` forms.
- [Accepting data with input properties (Angular)](https://angular.dev/guide/components/inputs) — `input()`, `input.required()` and `model()`.
- [Custom events with outputs (Angular)](https://angular.dev/guide/components/outputs) — `output()` and `emit()`.
- [Zoneless (Angular)](https://angular.dev/guide/zoneless) — `provideZonelessChangeDetection()` and what schedules change detection.
- [RxJS interop with Angular signals (Angular)](https://angular.dev/ecosystem/rxjs-interop) — `toSignal`, `toObservable` and `takeUntilDestroyed`.
