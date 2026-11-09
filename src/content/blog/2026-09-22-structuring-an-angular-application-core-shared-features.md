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

A new Angular app starts with a few pages, and any layout works. Two years and forty pages later, a component in `shared/` imports a feature service. Three pages call `HttpClient` with slightly different query strings. Renaming a URL segment means searching the whole app for `'/workspaces/'`. Nothing was wrong on the day each line was written. The app simply had no rule saying where things go.


## Four folders, four questions
Each top-level folder answers one question about a piece of code:

- **`api/`**: does it talk to the server? One typed client per resource, and nothing else calls `HttpClient`.
- **`core/`**: is it needed once, by the whole app? Authentication, interceptors, i18n, models, the URL map.
- **`features/`**: does it belong to one part of the product? One lazy-loaded folder per feature, with its pages, dialogs and service.
- **`shared/`**: is it reusable and ignorant of every feature? Pipes, small widgets, layout compositions.

The direction matters more than the names. `features` may import from `core`, `shared` and `api`. `shared` may never import from `features`: a "shared" component that needs a feature's service is not shared.

[Blouppy Starter](https://starter.blouppy.com/) follows this layout:

```text:clipboard=false
src/app/
├── api/            one typed client per resource: workspaces, teams, billing, ...
├── core/           auth/ i18n/ interceptors/ models/ real-time/ routing/ services/
├── features/       account, notifications, organization, workspace, ...
├── layout/         the shell: topbar, sidenav, account menu
├── shared/         components/ pipes/ utils/ ui/ (page header, section card, ...)
└── app.config.ts   app.routing.ts
```

`layout/` is the one addition. The shell is neither a feature nor reusable, and putting it in `core` would mix components with providers.

A service lives next to what it serves. The **API client** knows URLs and DTOs and holds no state. The **feature service**, such as `features/workspace/workspace.service.ts`, holds the feature's state as signals and calls the client. A **core service** is needed by the shell and every feature. A service moves to `core` when a second feature needs it, and not before. Moving it early is how `core` becomes the folder where everything goes.

The routes follow the features. The root routes `loadChildren` each feature's own route file, and the feature owns every URL below that point. Adding a page touches one folder.


## One typed map of URLs
A literal URL in a template is a string the compiler cannot check:

```html
<a [routerLink]="['/' + slug, 'workspaces', workspace.id, 'team']">Team</a>
```

Spread over forty components, the next change of URL scheme is a search and replace with no safety net. The Starter keeps every URL in `core/routing/app.paths.ts`, as functions returning the command array that `routerLink` and `Router.navigate` both take:

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
```

A link becomes `[routerLink]="workspacePath(slug, workspace.id, 'team')"`. A new URL scheme, such as moving the organization's slug to the front, changes this file and the route files, and no link. `workspacePath(slug, 12, 'teams')` does not compile.

The helpers do not prove a route exists for each path, though. Only visiting the app shows that `app.routing.ts` and `app.paths.ts` agree, which the Starter's [visual review with Playwright](/blog/2026-08-14-visual-review-for-an-angular-app-with-playwright/) does for every route.

The UI primitives (button, select, dialog) are not in the app at all. They come from `@blouppy/ui`, a library shared by four apps and compiled from source with each of them. `shared/ui/` holds only the app's own compositions on top, and features compose both without forking them. The [runtime theming article](/blog/2026-06-27-runtime-theming-with-css-tokens-and-tailwind-4/) covers the tokens it carries.


## ESLint holds the boundaries
A folder convention nothing checks lasts until the first deadline. The Starter turns the main rule into an error with the built-in `no-restricted-imports`:

```js
{
  files: ['src/app/shared/**/*.ts'],
  rules: {
    'no-restricted-imports': ['error', {
      patterns: [
        { group: ['app/shared/ui/*'], message: "Import design-system primitives from the 'app/shared/ui' barrel." },
        { group: ['app/features/*', '**/features/*'], message: 'shared/ must not depend on feature code.' },
      ],
    }],
  },
}
```

A second rule guards `api/`. Query parameters must go through a `toHttpParams` helper, enforced with `no-restricted-syntax`, because a raw object sends an `undefined` filter as the string `"undefined"`. The [ESLint setup article](/blog/2023-04-03-configure-eslint-with-angular/) covers the base configuration.

The lint does **not** forbid a feature importing another feature. `WorkspaceService` injects `OrganizationService`, because workspaces follow the current organization. A stricter project can add a rule per feature, or use [Nx module boundaries](https://nx.dev/features/enforce-module-boundaries) with tags. For a dozen features, one exception visible in review costs less than the tooling.


## Do we need a store?
Many Angular projects put a store at the centre: [NgRx Store](https://ngrx.io/guide/store), NGXS or Elf. It answers the same question as the folders: where does state live? It brings real benefits. Every piece of shared state has an address. The devtools show each action and the state before and after, so a bug report becomes a replayable sequence. Side effects are written apart from components.

It also costs. A classic NgRx feature is an action file, a reducer, selectors and effects. Following one click means opening four files. And the team learns a vocabulary on top of signals and RxJS.

There is a middle ground. A **service with signals** (private writable signals, read-only views, `computed()` for derived state) is already a small store. **NgRx SignalStore** gives that same shape a structure, with `withState`, `withComputed` and `withMethods`, and no actions or reducers.

The Starter has no store library. State lives in signal-based services, `providedIn: 'root'` when the shell needs it, and in component signals otherwise. RxJS stays at the edges, for HTTP and cancellation. A project-management app built on the Starter, with boards and offline reads, grew a query cache instead: most of its state is the server's, and a cache of server answers fits that better than a store of actions.

A store is the better choice for large teams where conventions matter more than lines, for complex client state such as an editor with undo, and when "what happened before this broke" is the usual question. When most state is the server's, signal services are enough, and moving one feature to a SignalStore later is a local change.

This is the front-end counterpart of the [hexagonal back end](/blog/2026-05-04-hexagonal-architecture-in-dotnet/): the same question, "whose code is this?", answered by a folder instead of a project.


## References
- [Angular style guide](https://angular.dev/style-guide) — Angular: conventions for file names and folder structure.
- [ESLint no-restricted-imports](https://eslint.org/docs/latest/rules/no-restricted-imports) — ESLint: the rule behind the folder boundaries.
- [NgRx SignalStore](https://ngrx.io/guide/signals/signal-store) — NgRx: `signalStore`, `withState`, `withComputed`, `withMethods`.
- [Nx: enforce module boundaries](https://nx.dev/features/enforce-module-boundaries) — Nx: tag-based rules for stricter boundaries.
