---
templateKey: 'blog-post'
title: 'Structuring an Angular application: core, shared, features and api'
date: 2026-09-22T09:00:00.000Z
author: Jimmy Boinembalome
authorimage: /img/jimmy.jpg
category: Angular
topic: 'Architecture'
illustration: 1
categorycolor: bg-red-100 text-red-800
featuredpost: true
description: >-
  Learn how to lay out a large Angular app in core, shared, features and api folders, keep URLs in one typed map, enforce boundaries with ESLint, and decide whether you need a store.
tags:
  - Development
  - Angular
  - Architecture
  - TypeScript
---

A new Angular app starts with `app.component.ts` and a few pages, and any layout works. Two years and forty pages later, a component in `shared/` imports a feature service, three pages call `HttpClient` with slightly different query strings, and renaming a URL segment means a search across the whole app for `'/workspaces/'`. Nothing was wrong on the day each line was written. The app simply had no rule saying where things go.

In this article, we will lay out an Angular application in four top-level folders (`core`, `shared`, `features`, `api`), route by feature, consume a design-system library as source, keep every URL in one typed map, and let ESLint hold the boundaries. Then we will look at the question every large Angular project meets: should the state live in a store?


## Four folders, four questions
Each folder answers one question about a piece of code:

- **`api/`**: does it talk to the server? One typed client per resource, and nothing else calls `HttpClient`.
- **`core/`**: is it needed once, by the whole app? Authentication, interceptors, internationalization, the app's models, the URL map.
- **`features/`**: does it belong to one part of the product? One folder per feature, lazy-loaded, with its pages, its dialogs and its own service.
- **`shared/`**: is it reusable and ignorant of any feature? Pipes, small widgets, layout compositions.

The direction matters more than the names: `features` may import from `core`, `shared` and `api`; `shared` may never import from `features`. When a "shared" component needs a feature's service, it is not shared.

[Blouppy Starter](https://starter.blouppy.com/) follows this layout in `front/application/src/app/`:

```text:clipboard=false
src/app/
├── api/            one typed client per resource: workspaces, teams, organizations, billing, ...
├── core/
│   ├── auth/       the guard, the session, the current user
│   ├── i18n/       Transloco bootstrap, LOCALE_ID
│   ├── interceptors/
│   ├── models/
│   ├── real-time/  the one SSE connection, the notification bell's state
│   ├── routing/    app.paths.ts, the URL map
│   └── services/
├── features/       account, checkout, notifications, organization, settings, workspace, ...
├── layout/         the shell: topbar, sidenav, account menu
├── shared/
│   ├── components/ pipes/ utils/
│   └── ui/         page, page-header, section-card, danger-zone, form-field, ...
└── app.config.ts   app.routing.ts
```

`layout/` is the one addition: the shell is neither a feature nor reusable, and putting it in `core` would mix components with providers.


## Where services live
A service lives next to what it serves. A service used by one feature stays in that feature's folder, even when it is `providedIn: 'root'`. `WorkspaceService` sits in `features/workspace/`, holds the list of workspaces as signals, and calls `WorkspacesApiService` from `api/`:

```ts
@Injectable({ providedIn: 'root' })
export class WorkspaceService {
  private readonly _workspacesApiService = inject(WorkspacesApiService);

  private readonly _workspaces = signal<Workspace[]>([]);
  private readonly _currentWorkspace = signal<Workspace | null>(null);

  public readonly workspaces = this._workspaces.asReadonly();
  public readonly currentWorkspace = this._currentWorkspace.asReadonly();
  public readonly currentColour = computed(() => this._currentWorkspace()?.colour ?? null);

  public createWorkspace(creation: WorkspaceCreation): Observable<Workspace> {
    return this._workspacesApiService
      .post(creation)
      .pipe(tap(created => this._workspaces.update(workspaces => [...workspaces, created])));
  }
}
```

Three kinds of service, three places:

- The **API client** (`api/workspaces-api.service.ts`) knows URLs and DTOs. It holds no state.
- The **feature service** (`features/workspace/workspace.service.ts`) holds the feature's state and calls the client.
- A **core service** (`core/services/user.service.ts`, `core/real-time/`) is needed by the shell and every feature.

A service moves to `core` when a second feature needs it, and not before. Moving it early is how `core` turns into the folder where everything goes.


## Feature-based routes
The root routes load features. Each feature brings its own route file, loaded on first visit:

```ts
export const appRoutes: Route[] = [
  { path: 'pricing', loadChildren: () => import('./features/pricing/pricing.routes') },
  {
    path: '',
    canActivate: [CanActivateGuard],
    component: LayoutComponent,
    children: [
      { path: 'account', loadChildren: () => import('./features/account/account.routes') },
      { path: 'notifications', loadChildren: () => import('./features/notifications/notifications.routes') },
      {
        path: ':organizationSlug',
        canMatch: [organizationGuard],
        loadChildren: () => import('./features/organization/organization-scope.routes'),
      },
    ],
  },
];
```

A route file uses a default export, so `loadChildren` needs no `.then(m => m.routes)`. The feature then owns its URLs below that point: `workspace.routes.ts` declares `:workspaceId` with its `general` and `team` children, its resolver and its guards. Adding a page to a feature touches that feature's folder only.


## Typed URL helpers instead of literal URLs
A literal URL in a template is a string the compiler cannot check:

```html
<a [routerLink]="['/' + slug, 'workspaces', workspace.id, 'team']">Team</a>
```

Spread over forty components, the next change of URL scheme is a search and replace with no safety net. The Starter puts every URL in one file, `core/routing/app.paths.ts`, as functions that return the command array `routerLink` and `Router.navigate` both take:

```ts
export type RoutePath = (string | number)[];

export type WorkspaceSection = 'general' | 'team';

export function organizationPath(organizationSlug: string): RoutePath {
  return [`/${organizationSlug}`];
}

export function workspacePath(organizationSlug: string, workspaceId: number, section?: WorkspaceSection): RoutePath {
  const path: RoutePath = [...organizationPath(organizationSlug), 'workspaces', workspaceId];

  return section ? [...path, section] : path;
}

export function pathToUrl(path: RoutePath): string {
  return path.join('/');
}
```

A component builds on the helper:

```ts
this._router.navigate(workspacePath(this._organizationService.currentSlug(), workspace.id));
```

What we gain:

- **One file to change.** A new URL scheme, such as putting the organization's slug first, is `app.paths.ts` plus the route files, and no link changes.
- **Typed sections.** `workspacePath(slug, 12, 'teams')` does not compile, because `WorkspaceSection` is `'general' | 'team'`.
- **Arguments in order.** Every helper of an organization's page takes the slug first, so a missing slug is a compile error instead of a broken link.
- **A cheap test.** `app.paths.spec.ts` asserts the arrays (`workspacePath('acme-corp', 12, 'team')` is `['/acme-corp', 'workspaces', 12, 'team']`), which documents the scheme in one place.

The helpers do not prove that a route exists for each path: `app.routing.ts` and `app.paths.ts` still have to agree, and only navigating the app shows they do. The Starter's [visual review with Playwright](/blog/2026-08-14-visual-review-for-an-angular-app-with-playwright/) visits every route, which catches the drift.


## A design-system library consumed as source
The UI primitives (button, select, dialog, toast, table) do not live in the app. They live in `front/libs/ui/`, a package named `@blouppy/ui` shared by four Angular apps: the application, the landing page, the documentation site and a playground. It is never published to a registry. An npm workspace at `front/` links it from the working tree, and each app resolves it through a `paths` entry:

```json
{
  "compilerOptions": {
    "paths": {
      "@blouppy/ui/*": ["../libs/ui/src/*/index.ts"],
      "app/*": ["./src/app/*"]
    }
  }
}
```

So `import { ButtonComponent } from '@blouppy/ui/button'` compiles the library's TypeScript with the app, in the same build. There is no library build step and no version to bump, and a change to a primitive shows in every app at once. The library's `package.json` declares one entry point per folder, with `"sideEffects": false`, so an app that never imports `@blouppy/ui/chart` never bundles Chart.js.

That gives the app three UI layers, each allowed to use the one below:

| Layer | Where | What belongs there |
| --- | --- | --- |
| Primitives | `front/libs/ui/src/` | Anything with no knowledge of the product |
| App compositions | `src/app/shared/ui/` | The shapes every page repeats: page header, section card, danger zone |
| Feature UI | `src/app/features/<feature>/` | Composes the two above and never forks them |

The cost is discipline: with no published versions, a breaking change to a primitive must fix its callers in the same change. The [runtime theming article](/blog/2026-06-27-runtime-theming-with-css-tokens-and-tailwind-4/) covers the tokens the library carries, and [the overlays article](/blog/2026-07-21-building-overlays-on-the-angular-cdk/) its dialogs and menus.


## Boundaries enforced by ESLint
A folder convention that nothing checks lasts until the first deadline. The Starter's `eslint.config.js` turns two of its rules into errors with the built-in `no-restricted-imports`:

```js
{
  files: ['src/app/shared/**/*.ts'],
  rules: {
    'no-restricted-imports': [
      'error',
      {
        patterns: [
          { group: ['app/shared/ui/*'], message: "Import design-system primitives from the 'app/shared/ui' barrel." },
          { group: ['app/features/*', '**/features/*'], message: 'shared/ must not depend on feature code.' },
        ],
      },
    ],
  },
}
```

- `shared/` may not import from `features/`.
- Everyone imports `shared/ui` through its barrel, `app/shared/ui`, never a file inside it.

A third rule guards `api/`: query parameters must go through a `toHttpParams` helper, enforced with `no-restricted-syntax`, because a raw object puts an `undefined` filter on the wire as the string `"undefined"`. The selector prefixes are checked too: `app-` for app components, `ui-` for the compositions. The [ESLint setup article](/blog/2023-04-03-configure-eslint-with-angular/) covers the base configuration.

What the lint does **not** forbid is a feature importing another feature: `WorkspaceService` injects `OrganizationService` from `features/organization/`, because the workspaces follow the current organization. That is a choice. A stricter project can add a rule per feature, or move to [Nx module boundaries](https://nx.dev/features/enforce-module-boundaries) with tags. For a dozen features, one exception we can see in review costs less than the tooling.


## What about a store?
Many Angular projects put a store at the centre of their architecture: [NgRx Store](https://ngrx.io/guide/store), [NgRx SignalStore](https://ngrx.io/guide/signals/signal-store), [NGXS](https://www.ngxs.io/) or [Elf](https://github.com/ngneat/elf). It is a legitimate choice, and it answers the same question as the folders: where does state live?

### What a store brings
- **One place for state.** Every piece of shared state has an address, and a reader knows where to look.
- **Devtools.** With NgRx Store and its devtools package, we can see each action, the state before and after, and replay them. A bug report becomes a sequence of actions.
- **Effects.** Side effects (HTTP calls, navigation, toasts) are written apart from the components and the reducers, which keeps components thin.
- **Conventions for a big team.** Actions, reducers, selectors and effects have one shape. Ten developers write state the same way, and a newcomer reads any feature like the others.

### What it costs
- **Boilerplate.** A classic NgRx feature is an action file, a reducer, selectors and effects. NgRx's `createFeature` and `createActionGroup` shorten it, but a simple list still takes more code than a service with a signal.
- **Indirection.** A click dispatches an action, an effect calls the API, another action carries the result, a reducer stores it, a selector reads it. Following one flow means opening four files.
- **A second model to learn.** On top of signals and RxJS, the team learns the store's own vocabulary.

### The lighter middle ground
Two steps sit between nothing and a full store. The first is a **service with signals**: private writable signals, read-only views, `computed()` for derived state and methods that change it. That is the `WorkspaceService` above. The second is **NgRx SignalStore**, which gives that same shape a structure without actions or reducers:

```ts
export const WorkspacesStore = signalStore(
  { providedIn: 'root' },
  withState({ workspaces: [] as Workspace[], loading: false }),
  withComputed(({ workspaces }) => ({
    count: computed(() => workspaces().length),
  })),
  withMethods(store => ({
    add(workspace: Workspace): void {
      patchState(store, { workspaces: [...store.workspaces(), workspace] });
    },
  }))
);
```

It keeps one convention across features and stays close to plain signals, which makes it a reasonable first store for a team that wants rules without the Redux ceremony.

### What the Starter does
The Starter has no store library: no `@ngrx/*`, no NGXS, no Elf in its dependencies. State lives in signal-based services, `providedIn: 'root'` when the shell needs it (`OrganizationService`, `WorkspaceService`, `NotificationService`), and in component signals otherwise. RxJS stays at the edges, for HTTP and cancellation, and becomes a signal at the component boundary with `toSignal()`. The real-time stream follows the same idea: a server event is [a signal to re-read](/blog/2026-09-13-server-sent-events-with-aspnet-core-and-angular/), and the service re-reads.

A project-management app built on the Starter, with boards, drag and drop and offline reads, grew a query cache instead: a root service that keeps server answers keyed by URL, invalidates them by path and persists a chosen few in IndexedDB. Most of its state is server state, and a cache of server answers was a better fit for that than a store of actions.

### When a store is the better choice
- **Large teams** where the conventions matter more than the lines saved.
- **Complex client state**: an editor with undo, a multi-step wizard, state many features change at once.
- **Debugging by history**: when "what happened before this broke" is the usual question, devtools pay for the boilerplate.

When most state is the server's and each feature owns its own, services with signals are enough. Starting with them is cheap, and moving one feature's service to a SignalStore later is a local change.


## Conclusion
A large Angular app stays readable when every file answers one question: does it talk to the server (`api`), serve the whole app (`core`), belong to a feature (`features`) or ignore all features (`shared`)? Routes follow the features, URLs come from one typed map, primitives come from a library compiled as source, and ESLint keeps `shared` away from `features`. A store is an option on top of that layout: worth its cost for a big team or complex client state, and replaceable by signal-based services everywhere else. It is the front-end counterpart of the [hexagonal back end](/blog/2026-05-04-hexagonal-architecture-in-dotnet/): the same question, "whose code is this?", answered by a folder instead of a project.


## References
- [Angular style guide](https://angular.dev/style-guide) — the official conventions for file names and folder structure.
- [Lazy-loading routes](https://angular.dev/reference/routing/lazy-loading) — `loadChildren` and `loadComponent`, including default exports.
- [Angular signals](https://angular.dev/guide/signals) — `signal`, `computed` and the read-only views a service exposes.
- [RxJS interop](https://angular.dev/ecosystem/rxjs-interop) — `toSignal` and `toObservable` at the component boundary.
- [ESLint no-restricted-imports](https://eslint.org/docs/latest/rules/no-restricted-imports) — the rule behind the folder boundaries.
- [Nx: enforce module boundaries](https://nx.dev/features/enforce-module-boundaries) — tag-based rules for stricter boundaries.
- [NgRx Store](https://ngrx.io/guide/store) — actions, reducers, selectors and effects.
- [NgRx SignalStore](https://ngrx.io/guide/signals/signal-store) — `signalStore`, `withState`, `withComputed`, `withMethods`.
- [NGXS](https://www.ngxs.io/) — a store built around classes and decorators.
- [Elf](https://github.com/ngneat/elf) — a reactive store built on RxJS.
- [npm workspaces](https://docs.npmjs.com/cli/using-npm/workspaces) — linking a local package from the working tree.
