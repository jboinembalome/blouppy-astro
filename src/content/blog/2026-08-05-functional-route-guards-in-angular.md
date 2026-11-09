---
templateKey: 'blog-post'
title: 'Functional route guards and resolvers in Angular'
date: 2026-08-05T09:00:00.000Z
author: Jimmy Boinembalome
authorimage: /img/jimmy.jpg
category: Angular
topic: 'Front end'
illustration: 2
categorycolor: bg-red-100 text-red-800
featuredpost: true
description: >-
  Learn to write Angular route guards and resolvers as functions: CanActivateFn, CanMatchFn, CanDeactivateFn, RedirectCommand, inject(), composition, tests, and why a guard is never security.
tags:
  - Development
  - Angular
  - TypeScript
  - Testing
---

Every Angular application decides things during a navigation. The visitor is not signed in. The URL names an organization they do not belong to. A form still holds unsaved text. The router takes plain functions for all of them.


## A guard is a function
A functional guard is a function the router calls in an injection context. There are four kinds:

- `CanMatchFn` decides whether a route definition matches at all.
- `CanActivateFn` decides whether the matched route may open.
- `CanDeactivateFn<T>` decides whether the current route may be left. It receives the component.
- `ResolveFn<T>` loads the data a route needs before it renders.

A guard returns a boolean, a `UrlTree` or a `RedirectCommand`, synchronously or as an `Observable` or a `Promise`:

```ts
export const adminGuard: CanActivateFn = () => {
  const session = inject(SessionService);
  const router = inject(Router);

  return session.isAdmin() ? true : router.createUrlTree(['/forbidden']);
};

const routes: Routes = [
  { path: 'admin', component: AdminComponent, canActivate: [adminGuard] },
];
```

There is nothing to provide. `inject()` works because the router runs the function inside the route's environment injector. The usual rule applies: call `inject()` synchronously, at the top. Inside a `map()` callback or after an `await`, the injection context is gone and `inject()` throws.


## False, a UrlTree or a RedirectCommand
The three results mean different things. `false` cancels the navigation, and on the very first navigation that leaves a blank page. A `UrlTree` cancels it and starts a new one to that tree. A `RedirectCommand` does the same and carries navigation options, such as `replaceUrl`.

A guard should not call `router.navigate()` and return `false`. That starts a second navigation while the first is still being decided. Returning the target lets the router cancel and redirect in one step.

`RedirectCommand` with `replaceUrl: true` is the one to use when the typed URL should not stay in the history. A bookmark to a forbidden page, or a URL with an outdated slug, should be replaced. Otherwise the back button bounces the user through the guard again:

```ts
export const canonicalSlugGuard: CanActivateFn = route => {
  const router = inject(Router);
  const current = inject(SlugService).canonicalOf(route.paramMap.get('slug')!);

  return current === route.paramMap.get('slug')
    ? true
    : new RedirectCommand(router.createUrlTree(['/', current]), { replaceUrl: true });
};
```

A resolver may return a `RedirectCommand` too. [Blouppy Starter](https://starter.blouppy.com/) uses that on its workspace pages: when the slug in the URL names another organization than the workspace's own, the resolver replaces the URL with the canonical one and keeps the rest of the path.


## Matching by slug with CanMatchFn
In the Starter, the organization leads the URL: `/acme-corp/workspaces/12/team`. The route is `:organizationSlug`, which would match anything. A `CanMatchFn` decides whether the segment names an organization the reader belongs to:

```ts
export const organizationGuard: CanMatchFn = (_route, segments) => {
  // Matching runs before the shell's own guard: a signed-out reader is left to it.
  if (!inject(AuthService).isAuthenticated()) {
    return true;
  }

  return inject(OrganizationService)
    .selectBySlug(segments[0].path)
    .pipe(map(organization => organization !== null));
};

// in the route table
{ path: ':organizationSlug', canMatch: [organizationGuard], loadChildren: () => import('./organization-scope.routes') },
{ path: '**', component: OrganizationNotFoundComponent },
```

A `CanMatchFn` that returns `false` cancels nothing. The router tries the next definition, here the `**` route, and shows "organization not found" with the URL left as typed. It also runs before `loadChildren`, so the lazy chunk of a route that cannot match is never downloaded. And `selectBySlug` makes the organization the current one, so the URL decides which organization is shown.

The sign-in guard of the Starter is even simpler. The session comes from the gateway's `/bff/user` endpoint, loaded by an app initializer before the first route matches, so the guard reads a signal synchronously. When nobody is signed in it calls `signIn()`, which leaves the SPA for `/bff/login`, and returns `false`: there is no Angular route to go to.


## Leaving a page and composing guards
A `CanDeactivateFn` usually delegates to the component, which knows what is unsaved. A project-management app built on the Starter types the component structurally, so one guard serves every page with a `canLeave()` method:

```ts
export const canLeave = (component: { canLeave(): Promise<boolean> }) => component.canLeave();
```

The page awaits its pending save and asks for confirmation only if some text could not be stored. A `CanDeactivateFn` only sees navigations inside the router, though. Closing the tab or reloading needs a `beforeunload` listener.

The `canActivate` array takes several guards. The router runs them all and keeps the first result that is not `true`, in array order. Order decides which redirect wins; it does not stop a later guard from running. When one check must wait for another, nest the routes: a parent's guards run before its children's.

A resolver has a cost worth knowing. It holds the navigation until it completes, and the previous page stays on screen with no feedback. For one fast request that is fine. For anything slow, loading in the component with a skeleton is better.


## Testing
A functional guard is a function, so a unit test calls it inside `TestBed.runInInjectionContext()` with mocked services and checks the result. That tests the function, not the routing. For a `CanMatchFn` that falls through to `**`, the Starter's specs use `RouterTestingHarness` with a small copy of the route table, and assert on `router.url` and the rendered component. Those tests catch an ordering mistake in the routes that a direct call never would.


## A guard is not security
Everything above runs in the user's browser. Anyone can change a signal in the developer tools, or call the API with `curl`. A guard keeps honest users away from pages that would fail and sends them somewhere useful. It protects nothing.

In the Starter, every rule a guard applies is enforced again by the API, behind the gateway described in [Keep the access token out of the browser](/blog/2026-05-10-keep-the-access-token-out-of-the-browser-bff-angular-yarp/). If removing every guard would expose data, the bug is in the API. And a page that can simply show "you do not have access" on a `403` needs no guard at all.


## References
- [Control route access with guards](https://angular.dev/guide/routing/route-guards) — Angular: `canActivate`, `canMatch`, `canDeactivate` and their return values.
- [Data resolvers](https://angular.dev/guide/routing/data-resolvers) — Angular: `ResolveFn` and how resolved data reaches the component.
- [RedirectCommand](https://angular.dev/api/router/RedirectCommand) — Angular API: a redirect with navigation options.
- [RouterTestingHarness](https://angular.dev/api/router/testing/RouterTestingHarness) — Angular API: navigating a real route table in a test.
