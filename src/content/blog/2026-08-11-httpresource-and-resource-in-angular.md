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

A zoneless Angular component reads its state from signals, and data from the server arrives as an `Observable`. Between the two, every component writes the same glue. A flag for loading, another for failure, a counter to retry, and a `switchMap` so that a stale answer never overwrites a fresh one. Each copy is slightly different, and each one is a place to forget the error case.

Angular 22 gives that glue a name: a **resource**.


## The glue, written by hand
Here is the billing history of an organization in [Blouppy Starter](https://starter.blouppy.com/), trimmed to its loading logic. It uses `toSignal`:

```ts
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

protected retry(): void {
  this.attempt.update(value => value + 1);
}
```

Nothing is wrong with it. `switchMap` cancels the previous organization's request, `startWith` shows the skeleton again, and `catchError` turns a failure into a state the template can render. The `attempt` counter makes "Try again" possible. It is also fifteen lines of plumbing, plus a `HistoryState` union and two constants. The other billing cards repeat it with small variations.


## One shape for asynchronous data
Whichever function creates it, a resource exposes the same signals:

- `value()`: the loaded value, or the `defaultValue` while there is none.
- `status()`: `'idle'`, `'loading'`, `'reloading'`, `'resolved'`, `'error'` or `'local'`.
- `error()`, `isLoading()` and `hasValue()`, which also narrows the type.
- `reload()`, `set()` and `update()`. Setting a value by hand moves it to `'local'`, handy for an optimistic update.

The statuses are precise. `loading` happens when the parameters change, and the value goes back to the default: the old value belonged to the old parameters. `reloading` happens after `reload()`, and the previous value stays on screen. `idle` means the parameters are `undefined`, so nothing is requested.

One rule catches everyone once. **In the `error` state, reading `value()` throws**, even with a `defaultValue`. Check `status()` or `hasValue()` first.


## Three ways to create one
`resource()` takes a reactive `params` function and an async `loader` that receives an `AbortSignal`. When the parameters change, the previous load is aborted. Passing that signal to `fetch` cancels the request on the network. It fits a browser API or an SDK that returns promises. It does not fit our own API in the Starter: a `fetch` skips the `HttpClient` interceptor that adds the `X-CSRF: 1` header the gateway requires.

`rxResource()`, from `@angular/core/rxjs-interop`, takes a `stream` that returns an `Observable` instead. Changing the parameters unsubscribes the previous one, which cancels the `HttpClient` request. This is the natural fit when API services already return observables. Here is the billing history again:

```ts
protected readonly history = rxResource({
  params: () => ({ organizationId: this.organization().id }),
  stream: ({ params }) => this.billingApiService.getInvoices(params.organizationId),
  defaultValue: [] as Invoice[],
});
```

The union, the constants, the counter and `retry()` are gone. The template switches on the resource's own status:

```html
@switch (history.status()) {
  @case ('loading') { <ui-skeleton height="2.5rem" /> }
  @case ('error') {
    <button uiButton (click)="history.reload()">{{ 'common.tryAgain' | transloco }}</button>
  }
  @default { <ui-table [value]="history.value()" /> }
}
```

Reading `value()` only in the `@default` branch respects the error rule. The behaviour is unchanged. Note that the stream must emit at least once: a `catchError(() => EMPTY)` leaves nothing to show, and Angular throws `NG0991`. Let the error through instead, and the resource moves to `error` on its own.

`httpResource()`, from `@angular/common/http`, goes one step further. It takes the URL itself as a reactive function and calls `HttpClient`, so the interceptors still run:

```ts
protected readonly invoices = httpResource<Invoice[]>(
  () => `/api/v1/billing/subscriptions/${this.organization().id}/invoices`,
  { defaultValue: [] }
);
```

Returning `undefined` keeps it `idle` until a parameter exists. A `parse` option can check the response at runtime. The cost is the API service: the URL moves into the component, and "where invoices come from" is split again.


## When the application keeps its own cache
A resource caches nothing between instances. Two components with the same URL make two requests. A project-management app built on the Starter reads through a `QueryCache` of its own instead. It answers a revisit at once from memory, then with the server's fresh answer. It is shared, persisted in IndexedDB for offline reads, and invalidated after writes.

There, `httpResource()` is the wrong tool: it calls `HttpClient` below the service where the cache lives, and gets none of that. `rxResource()` can sit on top, since each emission of the cache updates `value()`. But the status is `resolved` from the first, cached emission, and an invalidation does not reach the resource. When the application owns caching, a resource is at most a thin adapter over it.


## When not to use one
Resources are for reads. A parameter change or the component's destruction aborts the load in progress. That is right for a `GET` and dangerous for a `POST`, so writes stay `HttpClient` calls in the service.

A resource earns its place when data depends on changing parameters and the template shows loading and error states. A one-off read with nothing to show while it loads, such as the plan catalog on the pricing page, stays a `toSignal(..., { initialValue: [] })`. A stream that is not a request, like a form's `valueChanges`, is a [`toSignal` over the observable](/blog/2026-06-03-just-use-input-type-date-in-angular/). And the working `toSignal` version has no bug: the gain shows on the next component more than on this one.

The server side of caching answers other questions, covered in [caching authenticated API responses in ASP.NET Core](/blog/2026-07-27-caching-authenticated-api-responses-in-aspnet-core/).


## References
- [Async reactivity with resources](https://angular.dev/guide/signals/resource) — Angular: `resource()`, its statuses and `reload()`.
- [Reactive data fetching with httpResource](https://angular.dev/guide/http/http-resource) — Angular: `httpResource()`, its request object and `parse`.
- [RxJS interop with Angular signals](https://angular.dev/ecosystem/rxjs-interop) — Angular: `rxResource()`, `toSignal()` and `toObservable()`.
