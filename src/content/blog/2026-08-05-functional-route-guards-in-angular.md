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

Every Angular application ends up deciding things during a navigation: the visitor is not signed in, the URL names an organization they do not belong to, a settings page is reserved to administrators, a form still holds unsaved text. The router takes plain functions for all of them.

In this article, we will write route guards and resolvers as functions: `CanActivateFn`, `CanMatchFn`, `CanDeactivateFn` and `ResolveFn`, redirecting with `UrlTree` and `RedirectCommand`, using `inject()` inside them, composing them, and testing them. The examples come from [Blouppy Starter](https://starter.blouppy.com/) and from a project-management app built on it. We will also be clear about what a guard is not: a security boundary.


## The four functions
A functional guard is a function the router calls in an injection context. Each kind has its own signature:

| Type | Called with | Decides |
| --- | --- | --- |
| `CanMatchFn` | the `Route` and the URL segments | whether this route definition matches at all |
| `CanActivateFn` | the route snapshot and the router state | whether the matched route may open |
| `CanDeactivateFn<T>` | the component, the current route and state, the next state | whether the current route may be left |
| `ResolveFn<T>` | the route snapshot and the router state | the data the route needs before it renders |

A guard returns a boolean, a `UrlTree` or a `RedirectCommand`, synchronously or as an `Observable` or a `Promise`. A minimal one looks like this:

```ts
export const adminGuard: CanActivateFn = () => {
  const session = inject(SessionService);
  const router = inject(Router);

  return session.isAdmin() ? true : router.createUrlTree(['/forbidden']);
};
```

It is registered on the route like a class used to be, but there is nothing to provide:

```ts
{ path: 'admin', component: AdminComponent, canActivate: [adminGuard] }
```

`inject()` works because the router runs the function inside the route's environment injector. The rule is the usual one: call `inject()` synchronously, at the top of the function. Inside a `pipe(map(...))` callback or after an `await`, the injection context is gone and `inject()` throws.


## Returning false, a UrlTree or a RedirectCommand
The three results mean different things:

- `false` cancels the navigation. The user stays where they were, and on the very first navigation that means a blank page.
- A `UrlTree` cancels the navigation and starts a new one to that tree.
- A `RedirectCommand` does the same, and carries `NavigationBehaviorOptions` with it: `replaceUrl`, `skipLocationChange`, `state`, `browserUrl`.

A guard should not call `router.navigate()` itself and return `false`: that starts a second navigation while the first is still being decided. Returning the target lets the router cancel and redirect in one step.

`RedirectCommand` is the one to reach for when the URL the user typed should not stay in the history. A bookmark to a page they cannot open, or a URL with an outdated slug, should be *replaced*, so that the back button does not bounce them through the guard again.


## Signing in: a guard against the gateway's session
The Starter's front end never holds a token. It talks to a gateway that keeps the session in a cookie, as described in [Keep the access token out of the browser](/blog/2026-05-10-keep-the-access-token-out-of-the-browser-bff-angular-yarp/), and asks it who is signed in with `GET /bff/user`. The `AuthService` turns that answer into a signal, and an app initializer waits for it before the first route is matched:

```ts
export const provideAuth = (): (Provider | EnvironmentProviders)[] => [
  provideAppInitializer(() => inject(AuthService).getSession()),
];
```

Because the session is already known when the router starts, the guard can read it synchronously:

```ts
export const CanActivateGuard: CanActivateFn = () => {
  const authService = inject(AuthService);

  if (authService.isAuthenticated()) {
    return true;
  }

  authService.signIn();

  return false;
};
```

`signIn()` sets `window.location.href` to `/bff/login?returnUrl=...` with the current path and query string, so returning `false` is correct here: the page is about to leave the SPA, and there is no Angular route to redirect to. The same body is used as a `CanActivateChildFn` on the shell route, so every child is checked as well.

Loading the session in an initializer is a choice: the alternative is a guard returning `getSession().pipe(map(...))`, and every guard needing the user waiting on it too.


## Matching by slug: CanMatchFn
In the Starter, the organization leads the URL: `/acme-corp/workspaces/12/team`. The route is `:organizationSlug`, which would match anything, so a `CanMatchFn` decides whether the segment really names an organization the reader belongs to:

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
```

```ts
{
  path: ':organizationSlug',
  canMatch: [organizationGuard],
  loadChildren: () => import('./features/organization/organization-scope.routes'),
},
{ path: '**', component: OrganizationNotFoundComponent },
```

A `CanMatchFn` that returns `false` does not cancel anything: the router tries the next route definition. Here, that is the `**` route, which shows an "organization not found" page with the URL left as the user typed it. Two more properties make `canMatch` the right tool for this case. It runs before `loadChildren`, so the lazy chunk of a route that cannot match is never downloaded. And `selectBySlug` also makes the organization the current one, so the URL decides which organization is shown, not whatever was remembered from the last visit.


## Sending a bookmark somewhere useful: RedirectCommand
Settings pages are reserved by role: a member may see the organization's member list but not its billing. The menu hides what a person cannot open, and a guard covers what the menu cannot, such as a bookmark or a link sent by an administrator:

```ts
export const settingsEntryGuard: CanActivateFn = (route, state) => {
  const router = inject(Router);
  const entry = route.data[SETTINGS_ENTRY] as SettingsEntryId;
  const target = settingsUrlOf(state.url) ?? { level: 'account' as const, workspaceId: null };

  return inject(SettingsContextService)
    .accessFor(target)
    .pipe(
      map(({ rights, menu }) => {
        if (isSettingsEntryAllowed(entry, rights)) {
          return true;
        }

        const group = menu.find(candidate => candidate.level === entry.split('.')[0]) ?? menu[0];
        const first = group?.entries[0]?.path ?? [ACCOUNT_PATH];

        return new RedirectCommand(router.createUrlTree(first), { replaceUrl: true });
      })
    );
};
```

Two details matter. The guard reads its entry from `route.data`, so one function serves every settings route. And the menu and the guard call the same `isSettingsEntryAllowed`, so the app never offers a page the guard refuses, nor guards a page the menu does not offer.


## Resolvers that redirect
A `ResolveFn` loads data before the route renders, and can also return a `RedirectCommand`. The Starter uses that for canonical URLs. A workspace is addressed by its id, and the id alone says which organization it belongs to. When the slug in the URL names another organization, because the link was copied before a move or the slug was typed by hand, the resolver replaces the URL with the right one:

```ts
export const WorkspaceResolver: ResolveFn<Workspace> = (route, state) => {
  const workspaceService = inject(WorkspaceService);
  const organizationService = inject(OrganizationService);
  const router = inject(Router);
  const workspaceId = Number(route.paramMap.get('workspaceId'));

  return workspaceService.openWorkspace(workspaceId).pipe(
    map(workspace => {
      const urlSlug = route.pathFromRoot.map(s => s.paramMap.get('organizationSlug')).find(slug => slug !== null);
      const owner = organizationService.organizations().find(o => o.id === workspace.organizationId);

      if (urlSlug && owner && owner.slug !== urlSlug) {
        const url = router.parseUrl(state.url);
        const [, ...rest] = url.root.children[PRIMARY_OUTLET].segments.map(segment => segment.path);
        const canonical = router.createUrlTree([...organizationPath(owner.slug), ...rest], {
          queryParams: url.queryParams,
          fragment: url.fragment ?? undefined,
        });

        return new RedirectCommand(canonical, { replaceUrl: true });
      }

      return workspace;
    })
  );
};
```

The rest of the path, the query string and the fragment are kept, so `/old-slug/workspaces/12/team#members` lands on the same tab of the same page. A workspace of an organization the reader is not in keeps its URL, and the API answers no.

A resolver holds the navigation until it completes, so the previous page stays on screen with no feedback while it loads. That is fine for one fast request. For anything slow, loading in the component, with a skeleton, gives a better experience than a resolver. An error in a resolver also cancels the navigation, so a resolver that can fail needs a `catchError` that returns something the page can render, or a redirect.


## Leaving a page: CanDeactivateFn
The Starter has no form that needs one, but the project-management app built on it has a document editor that saves as the user types. Leaving the page must wait for the last save, and ask only when some text could not be stored. The guard delegates to the component, which knows what is unsaved:

```ts
export const canLeave = (component: { canLeave(): Promise<boolean> }): Promise<boolean> => component.canLeave();
```

```ts
{ path: 'specifications/:specificationId', component: SpecificationRouteComponent, canDeactivate: [canLeave] }
```

The page's `canLeave()` awaits the pending write, returns `true` when it went through, and otherwise opens a confirmation dialog whose answer becomes the guard's result. Typing the component parameter as a structural `{ canLeave(): Promise<boolean> }` lets the same guard serve any page with that method.

A `CanDeactivateFn` only sees navigations inside the router. Closing the tab, reloading or typing another address does not go through it; that needs a `beforeunload` listener, and the browser shows its own generic prompt.


## Composing guards
The `canActivate` array takes several guards. The router starts all of them, then takes the first result that is not `true`, in array order. Order decides which redirect wins; it does not stop a later guard from running. When one check must only happen after another succeeded, compose them in one function:

```ts
export const allOf = (...guards: CanActivateFn[]): CanActivateFn => (route, state) => {
  const injector = inject(EnvironmentInjector);

  return guards.reduce<Observable<GuardResult>>(
    (previous, guard) =>
      previous.pipe(
        switchMap(result => (result === true ? runInInjectionContext(injector, () => wrap(guard(route, state))) : of(result)))
      ),
    of(true)
  );
};
```

Here `wrap` turns a `MaybeAsync<GuardResult>` into an observable (`isObservable(v) ? v : from(Promise.resolve(v))`), and `runInInjectionContext` gives each later guard an injection context again, since it runs inside a `switchMap`. In practice, the Starter does not need this helper: parents and children are checked in sequence, so the shell's sign-in guard runs before any guard of a child route. Nesting routes is often all the composition we need.

A related rule: guards and resolvers rerun when the route's parameters change, which is the default `runGuardsAndResolvers: 'paramsChange'`. A query parameter change alone does not rerun them unless the route asks for it.


## Testing them
A functional guard is a function, so a unit test calls it inside `TestBed.runInInjectionContext`:

```ts
it('should send a signed-out visitor to sign in', () => {
  // Arrange
  const signIn = vi.fn();
  TestBed.configureTestingModule({
    providers: [{ provide: AuthService, useValue: { isAuthenticated: () => false, signIn } }],
  });

  // Act
  const result = TestBed.runInInjectionContext(() =>
    CanActivateGuard({} as ActivatedRouteSnapshot, {} as RouterStateSnapshot)
  );

  // Assert
  expect(result).toBe(false);
  expect(signIn).toHaveBeenCalled();
});
```

This is fast, but it tests the function, not the routing. For guards whose meaning depends on the route table, such as a `CanMatchFn` falling through to `**`, the Starter's specs use `RouterTestingHarness` with a small copy of the real routes and assert on `router.url` and the rendered component: an unknown slug shows the "not found" stub with the URL unchanged, a member opening `/acme/settings/general` ends on `/acme/settings/members`. Those tests catch an ordering mistake in the route table that a direct call never would.


## A guard is not security
Everything above runs in the user's browser. Anyone can open the developer tools, change a signal, or call the API with `curl`. A guard keeps honest users away from pages that would fail, and sends them somewhere useful. It protects nothing.

In the Starter, every rule a guard applies is enforced again by the API: the gateway attaches the access token, and the controllers' authorization policies decide. The guards are written with that in mind. `organizationGuard` lets a signed-out reader through to the shell's guard instead of asking for anything, and `WorkspaceResolver` leaves the URL of a workspace the reader cannot see untouched and lets the API refuse it. If removing every guard from the app would expose data, the bug is in the API.


## When not to bother
Guards and resolvers have costs. Each one is code on the critical path of every navigation, and a slow one makes the app feel frozen. A resolver moves loading out of the component, where a skeleton could show it, into a gap where nothing does. A guard that duplicates a rule of the API can drift from it.

So it depends. If a page can simply show "you do not have access" when the API answers `403`, that page needs no guard. If the data can load in the component with a loading state, it needs no resolver. Guards earn their place for sign-in, for URLs that must be rewritten (slugs, legacy paths, canonical forms), for keeping menus and pages consistent, and for unsaved changes.


## Conclusion
Functional guards are plain functions with `inject()` at the top: `CanMatchFn` to choose between route definitions before anything loads, `CanActivateFn` to allow or redirect, `CanDeactivateFn` to protect unsaved work, and `ResolveFn` to load data or rewrite a URL. Returning a `RedirectCommand` with `replaceUrl` keeps the history clean, and `TestBed.runInInjectionContext` and `RouterTestingHarness` cover the function and the routing. Through all of it, the guard is a convenience for the user, and the API stays the one that says no. This is how routing works in [Blouppy Starter](https://starter.blouppy.com/).

## References
- [Control route access with guards (Angular)](https://angular.dev/guide/routing/route-guards) — the guide to `canActivate`, `canMatch`, `canDeactivate` and their return values.
- [Data resolvers (Angular)](https://angular.dev/guide/routing/data-resolvers) — `ResolveFn` and how resolved data reaches the component.
- [RedirectCommand (Angular API)](https://angular.dev/api/router/RedirectCommand) — a redirect with navigation options.
- [CanMatchFn (Angular API)](https://angular.dev/api/router/CanMatchFn) — the signature and its fall-through behaviour.
- [TestBed (Angular API)](https://angular.dev/api/core/testing/TestBed) — `runInInjectionContext` for testing functions that call `inject()`.
- [RouterTestingHarness (Angular API)](https://angular.dev/api/router/testing/RouterTestingHarness) — navigating a real route table in a test.
- [Window: beforeunload event (MDN)](https://developer.mozilla.org/docs/Web/API/Window/beforeunload_event) — what a `CanDeactivateFn` cannot see.
