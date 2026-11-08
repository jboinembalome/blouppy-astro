---
templateKey: 'blog-post'
title: 'httpResource, rxResource and resource in Angular: loading data as signals'
date: 2026-08-11T09:00:00.000Z
author: Jimmy Boinembalome
authorimage: /img/jimmy.jpg
category: Angular
topic: 'Front end'
illustration: 3
categorycolor: bg-red-100 text-red-800
featuredpost: true
description: >-
  Learn how resource(), rxResource() and httpResource() load data as signals in Angular 22: status, errors, reloading, cancellation, and when toSignal or your own cache is still the better fit.
tags:
  - Development
  - Angular
  - TypeScript
  - Signals
  - RxJS
---

A zoneless Angular component reads its state from signals, and data from the server arrives as an `Observable`. Between the two, every component writes the same glue: a `subscribe` that sets a value, a flag for loading, another for failure, a counter to retry, and a `switchMap` so that a stale answer never overwrites a fresh one. The glue works, but each copy is slightly different, and each one is a place to forget the error case.

In this article, we will look at the three APIs Angular 22 offers for that glue: `resource()`, `rxResource()` and `httpResource()`. We will see what a resource exposes, how it reloads and cancels, then rewrite a real component of [Blouppy Starter](https://starter.blouppy.com/) with it. We will finish with the case where a resource is the wrong tool: an application that keeps its own query cache.


## Before resources: subscribe, then toSignal
The first version most of us wrote is a subscription in the constructor:

```ts
export class InvoicesComponent {
  private readonly http = inject(HttpClient);

  protected readonly invoices = signal<Invoice[]>([]);
  protected readonly isLoading = signal(true);

  constructor() {
    this.http
      .get<Invoice[]>('/api/invoices')
      .pipe(takeUntilDestroyed())
      .subscribe({
        next: invoices => {
          this.invoices.set(invoices);
          this.isLoading.set(false);
        },
        error: () => this.isLoading.set(false),
      });
  }
}
```

It loads once. As soon as the URL depends on an input, the subscription has to move into an `effect`, and an `effect` that subscribes has to cancel the previous request itself.

[`toSignal`](https://angular.dev/api/core/rxjs-interop/toSignal) is the next step, and it is what the Starter does today. Here is the billing history of an organization, trimmed to the loading logic:

```ts
interface HistoryState {
  status: 'loading' | 'ready' | 'failed';
  invoices: Invoice[];
}

const LOADING: HistoryState = { status: 'loading', invoices: [] };
const FAILED: HistoryState = { status: 'failed', invoices: [] };

export class BillingHistoryComponent {
  private readonly billingApiService = inject(BillingApiService);

  public readonly organization = input.required<Organization>();

  /** Bumped by a retry, so a failed read can be asked for again. */
  private readonly attempt = signal(0);

  private readonly source = computed(() => ({ organizationId: this.organization().id, attempt: this.attempt() }));

  private readonly history = toSignal(
    toObservable(this.source).pipe(
      switchMap(({ organizationId }) =>
        this.billingApiService.getInvoices(organizationId).pipe(
          map(invoices => ({ status: 'ready', invoices }) as HistoryState),
          catchError(() => of(FAILED)),
          startWith(LOADING)
        )
      )
    ),
    { initialValue: LOADING }
  );

  protected readonly status = computed(() => this.history().status);
  protected readonly invoices = computed(() => this.history().invoices);

  protected retry(): void {
    this.attempt.update(value => value + 1);
  }
}
```

Everything is correct here. `switchMap` cancels the request of the previous organization, `startWith` shows the skeleton again, `catchError` turns a failure into a state the template can render, and the `attempt` counter makes "Try again" possible. It is also about fifteen lines of plumbing, written again in each billing card (`current-subscription`, `current-plan`, `ai-usage`) with small variations: one swallows errors, another leaves them to the error interceptor, and all three take a `refreshToken` input that plays the role of `attempt`.


## One shape for asynchronous data
A **resource** is that plumbing, given a name and a fixed shape. Whichever function creates it, a `Resource<T>` exposes:

- `value()`: the loaded value, or the `defaultValue` while there is none.
- `status()`: one of `'idle'`, `'loading'`, `'reloading'`, `'resolved'`, `'error'` and `'local'`.
- `error()`: the last error while in the `error` state.
- `isLoading()`: `true` while loading or reloading.
- `hasValue()`: whether there is a value to show, which also narrows the type in TypeScript.

The resource returned by the three functions is writable, so it adds `reload()`, `set()` and `update()`. Setting a value by hand moves the resource to `'local'` and aborts any load in flight, which is handy for an optimistic update.

The statuses carry a precise meaning:

- **`loading`** happens when the parameters change. The value goes back to the default: we are now loading *another* thing, and the old value belongs to the old parameters.
- **`reloading`** happens after `reload()`. The parameters are the same, so the previous value stays on screen while the new one loads.
- **`idle`** happens when the parameters are `undefined`. Nothing is requested.

One rule catches everyone once: **in the `error` state, reading `value()` throws**, even with a `defaultValue`. A template that calls `value()` unconditionally breaks the page on the first failed request. Check `status()` or `hasValue()` first.


## resource(): a promise and an AbortSignal
`resource()` takes a reactive `params` function and an asynchronous `loader`:

```ts
export class UserCardComponent {
  public readonly userId = input.required<number>();

  protected readonly user = resource({
    params: () => ({ id: this.userId() }),
    loader: async ({ params, abortSignal }) => {
      const response = await fetch(`/api/users/${params.id}`, { signal: abortSignal });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      return (await response.json()) as User;
    },
  });
}
```

When `userId` changes, the `params` function produces a new value and the resource aborts the previous load through `abortSignal`. Passing that signal to `fetch` is what cancels the request on the network; without it, the old request runs to the end, and the resource simply ignores its answer. Either way, a stale answer never lands in `value()`.

`resource()` is the most general of the three, and also the one that knows nothing about `HttpClient`. In the Starter, every call goes through an interceptor that adds the `X-CSRF: 1` header the gateway requires, as we saw when we [kept the access token out of the browser](/blog/2026-05-10-keep-the-access-token-out-of-the-browser-bff-angular-yarp/). A `fetch` inside a loader skips it, and the gateway refuses the request. For our own API, `resource()` with `fetch` is the wrong choice; it fits a browser API or a third-party SDK that returns promises.


## rxResource(): the same, from an Observable
`rxResource()`, from `@angular/core/rxjs-interop`, replaces the `loader` with a `stream` that returns an `Observable`:

```ts
protected readonly invoices = rxResource({
  params: () => ({ organizationId: this.organization().id }),
  stream: ({ params }) => this.billingApiService.getInvoices(params.organizationId),
  defaultValue: [] as Invoice[],
});
```

When the parameters change, the previous subscription is unsubscribed, which cancels the `HttpClient` request. Each emission updates `value()`, so an `Observable` that emits several times keeps the resource current.

The `Observable` must emit at least once, or fail. One that completes without emitting, typically because of `catchError(() => EMPTY)`, leaves the resource with nothing to show, and Angular throws `NG0991`. The `catchError(() => of(FAILED))` habit from the `toSignal` version has no place here either: let the error through, and the resource moves to `error` on its own.

This is the natural fit for an application whose API services already return observables, which is the case of the Starter's `BillingApiService`.


## httpResource(): HttpClient as a signal
`httpResource()`, from `@angular/common/http`, goes one step further: it takes the URL itself as a reactive function and makes the request with `HttpClient`:

```ts
protected readonly invoices = httpResource<Invoice[]>(
  () => `/api/v1/billing/subscriptions/${this.organization().id}/invoices`,
  { defaultValue: [] }
);
```

Because it is backed by `HttpClient`, the interceptors run, so the `X-CSRF` header and the error interceptor still apply. A few details make it more than a shortcut:

- The function can return an `HttpResourceRequest` instead of a URL, with `method`, `params`, `headers`, `body`, `timeout` and the other `fetch` options.
- Returning `undefined` leaves the resource `idle`, which is how a request waits for a missing parameter.
- `parse` receives the raw response and returns the typed value, the place for a runtime schema check.
- The resource also exposes `headers()`, `statusCode()` and `progress()`.
- `httpResource.text()`, `.blob()` and `.arrayBuffer()` change how the body is read; the default is JSON.

What it costs is the API service. The URL moves from `BillingApiService` into the component, and the service's single place for "where do invoices come from" is split again.


## The billing history, with a resource
Here is the same component with `rxResource`, keeping `BillingApiService` as the one place that knows the URL:

```ts
export class BillingHistoryComponent {
  private readonly billingApiService = inject(BillingApiService);

  public readonly organization = input.required<Organization>();

  protected readonly history = rxResource({
    params: () => ({ organizationId: this.organization().id }),
    stream: ({ params }) => this.billingApiService.getInvoices(params.organizationId),
    defaultValue: [] as Invoice[],
  });
}
```

The `HistoryState` union, the two constants, the `attempt` counter and the `retry()` method are gone. The template switches on the resource's own status:

```html
@switch (history.status()) {
  @case ('loading') {
    <ui-skeleton height="2.5rem" />
  }
  @case ('error') {
    <button uiButton type="button" variant="outlined" (click)="history.reload()">
      {{ 'common.tryAgain' | transloco }}
    </button>
  }
  @default {
    <ui-table size="small" [value]="history.value()" />
  }
}
```

The `@default` branch also covers `'reloading'` and `'local'`, where a value exists. Reading `history.value()` only there respects the rule of the error state. Behaviour is unchanged: a new organization resets the list and shows the skeleton, a failure shows the retry button, and a retry re-reads the same organization.

A sibling card, `current-subscription`, adds a `refreshToken` input that the page bumps after a plan change. With a resource, the page could call `reload()` on it, or the token can stay among the `params`, since a change of `params` reloads as well.


## When the application keeps its own cache
The Starter reads its data through API services that call `HttpClient` directly, so a resource is a straight replacement. A project-management app built on the Starter took another path: its API services read through a `QueryCache` of their own, a stale-while-revalidate cache that answers a revisit at once from memory, then with the server's fresh answer. It is shared by every component reading the same URL, scoped per user and organization, partly persisted in IndexedDB so that a reload or an offline session can paint a board, and purged on sign-out. Its read looks like this:

```ts
get(projectId: number): Observable<Correction[]> {
  const url = correctionsReadPath(projectId);

  return this._queryCache.read(this._queryCache.key(url), () => this._httpClient.get<Correction[]>(url));
}
```

After a write, the service invalidates the paths it changed, and a generation counter drops an answer that was requested before the write and arrived after it, so a slow read never puts back what the write just made stale.

That matters for the choice of API:

- **`httpResource()` bypasses such a cache.** It calls `HttpClient` itself, below the API service where the cache lives, so a component using it gets neither the instant revisit, the offline copy nor the invalidation. A resource caches nothing between instances: two components with the same URL make two requests.
- **`rxResource()` can sit on top of it.** `read` emits the cached value, then the fresh one, and each emission updates `value()`. One consequence: the status is `resolved` from the first, cached emission, so `isLoading()` does not say that a fresher answer is on its way.
- **Invalidation does not reach a resource.** The cache drops an entry, but nothing tells the resource to read again; that is a `reload()` the component or a live-update signal has to make.

When the application already owns caching, invalidation and offline reads, a resource is at most a thin adapter over that layer, never a replacement for it.


## Pitfalls
- **Reading `value()` in the error state throws.** Guard it with `status()` or `hasValue()`.
- **Resources are for reads.** A new parameter or the destruction of the component aborts the load in progress, which is the right behaviour for a `GET` and a dangerous one for a `POST`. Writes stay `HttpClient` calls in the API service.
- **`params` must be cheap.** It runs inside a reactive context like a `computed`; it should read signals and build an object, nothing more.
- **A loader that ignores `abortSignal`** still discards stale answers, but leaves the requests running.
- **`EMPTY` in `rxResource`** throws `NG0991`; let the error through instead.


## When toSignal is enough
A resource earns its place when data depends on changing parameters and the template needs the loading and error states. When it does not, the simpler tool stays the right one:

- **A one-off read with nothing to show while it loads**, such as the Starter's plan catalog on the pricing page, is `toSignal(this.billingApiService.getPlans(), { initialValue: [] })`.
- **A stream of values that are not a request**, like a form's `valueChanges` or the router's parameters, is a [`toSignal` over the observable](/blog/2026-06-03-just-use-input-type-date-in-angular/), not a resource.
- **A component whose observable pipeline does more than load**, combining several sources or debouncing user input, may read better as RxJS ending in a single `toSignal`.

Moving every component at once buys little either. The `toSignal` version of the billing history has no bug; the gain is less code and one shape for status and errors, which pays off on the next component, not on the working one.


## Conclusion
`resource()`, `rxResource()` and `httpResource()` give every asynchronous read the same shape: a value, a status, an error, `reload()`, and cancellation when the parameters change. They replace the `switchMap`, `startWith`, `catchError` and retry counter we wrote by hand around `toSignal`. In an application like the Starter, `rxResource()` over the existing API services is the smallest step, and `httpResource()` suits a component that owns its URL. In an application that keeps its own query cache, the cache stays in charge, and a resource is only a way to read it as a signal.

The server side of caching answers different questions; we covered it in [caching authenticated API responses in ASP.NET Core](/blog/2026-07-27-caching-authenticated-api-responses-in-aspnet-core/).

## References
- [Async reactivity with resources (angular.dev)](https://angular.dev/guide/signals/resource) — `resource()`, its statuses, `reload()` and chaining.
- [Reactive data fetching with httpResource (angular.dev)](https://angular.dev/guide/http/http-resource) — `httpResource()`, its request object and `parse`.
- [RxJS interop with Angular signals (angular.dev)](https://angular.dev/ecosystem/rxjs-interop) — `rxResource()`, `toSignal()` and `toObservable()`.
- [`toSignal` API (angular.dev)](https://angular.dev/api/core/rxjs-interop/toSignal) — the observable-to-signal bridge used before resources.
- [HTTP interceptors (angular.dev)](https://angular.dev/guide/http/interceptors) — why a request should go through `HttpClient`.
- [AbortSignal (MDN)](https://developer.mozilla.org/docs/Web/API/AbortSignal) — how `fetch` cancels a request.
- [Blouppy Starter](https://starter.blouppy.com/) — the starter kit whose billing cards serve as the example.
