---
templateKey: 'blog-post'
title: 'Keeping an Angular bundle small: budgets, lazy routes and @defer'
date: 2026-08-17T09:00:00.000Z
author: Jimmy Boinembalome
authorimage: /img/jimmy.jpg
category: Angular
topic: 'Tooling'
illustration: 1
categorycolor: bg-red-100 text-red-800
featuredpost: true
description: >-
  Learn how to measure an Angular bundle with the build's stats, hold it with budgets, and keep heavy code such as an editor or a diagram library out of the first load with lazy routes and @defer.
tags:
  - Development
  - Angular
  - TypeScript
---

An Angular app rarely gets heavy in one commit. A markdown editor arrives for one form, a charting library for one page, a diagram renderer because the editor can show diagrams. Each import is a single line, and the build stays green. One day the first page takes three seconds on a phone. Nobody chose that: nothing measured it.

The fix is a habit: measure the build, hold the result with a budget, and keep heavy code out of the first load. The example is the front end of [Blouppy Starter](https://starter.blouppy.com/).


## Measure first
The application builder prints a table at the end of every production build. Here is the Starter's, trimmed to its totals and largest lazy chunks:

```text
Initial chunk files | Names                            |  Raw size | Estimated transfer size
...
                    | Initial total                    | 799.78 kB |               194.86 kB

Lazy chunk files    | Names                            |  Raw size | Estimated transfer size
chunk-BQoEoLIv.js   | elk-276RUBZZ                     |   1.47 MB |               345.76 kB
chunk-DZcLD-qd.js   | assistant-conversation-component | 941.31 kB |               235.20 kB
chunk-ruWW7kYx.js   | organization-routes              | 211.07 kB |                37.13 kB
...and 95 more lazy chunks files.
```

**Initial total** is what the browser downloads before the first page renders. The **lazy chunks** are fetched only when something asks for them. The raw size is what the browser parses and runs; the transfer size estimates what crosses the network.

The table says how big a chunk is, not what is in it. `ng build --stats-json` writes `dist/stats.json`, an esbuild metafile listing every input of every output. [esbuild's bundle analyzer](https://esbuild.github.io/analyze/) turns it into a treemap.

That is how the Starter found a dependency it did not use. The analyzer showed `@angular/animations` among the largest inputs of `main`. `provideAnimations()` registered it in `app.config.ts`, but nothing in the app declared an animation trigger. Removing both took the initial total from 864 kB to 800 kB raw, and `main` from 272 kB to 208 kB. Guessing would not have found it.


## A budget that fails the build
Measuring once is a snapshot. A **budget** turns the number into a check on every build. It lives in the production configuration of `angular.json`. Here are the Starter's:

```json
"budgets": [
  { "type": "initial", "maximumWarning": "850kB", "maximumError": "900kB" },
  { "type": "anyComponentStyle", "maximumWarning": "6kb" }
]
```

Past `maximumWarning`, the build prints a warning. Past `maximumError`, it fails, and so does CI. The sizes compared are the raw ones. The `initial` line was added with the cleanup above, a little above today's 800 kB. A budget set far above the current size never fires.


## Lazy routes
The cheapest split is the router. A route declared with `loadComponent` or `loadChildren` becomes its own chunk. In the Starter, only the layout is eager. Every feature (account, notifications, organization settings, workspaces, pricing) is a lazy chunk, which is where `organization-routes` comes from.

One rule keeps the split working: **nothing eager may import from a lazy feature**. One import from `features/account/` in the layout pulls that file, and all it imports, back into the initial chunks. The build does not complain; only the table changes.

The Starter also registers `withPreloading(PreloadAllModules)`. Once the first page is up, the router downloads every lazy route in the background. So lazy routes keep features out of the *first* load, but a visitor still downloads them shortly after. That suits an app people stay in. It also means a heavy library that most visitors never need cannot rely on a lazy route alone.


## @defer inside an eager page
Some heavy code sits inside a page that is already loaded. The Starter's assistant panel lives in the layout, and renders answers as markdown with a tiptap-based view. A static import would put tiptap and ProseMirror into `main`. A `@defer` block moves what it renders into its own chunk:

```html
@if (assistant.entries().length === 0) {
  <ui-empty-state icon="pi pi-sparkles" [heading]="'assistant.empty.heading' | transloco" />
} @else {
  @defer (on immediate) {
    <app-assistant-conversation [entries]="assistant.entries()" />
  } @placeholder {
    <ui-skeleton height="6rem" />
  }
}
```

That is the 941 kB `assistant-conversation-component` chunk, larger than the whole initial load. Preloading does not fetch deferred chunks, so a visitor who never opens the assistant never downloads it. The trigger is `on immediate` because the `@if` already guards it. `on viewport`, `on interaction` and `prefetch on idle` fit other cases.

The split needs two conditions. The deferred components must be standalone. And they must not be used anywhere else in the file outside the block: a `viewChild()` query on one of them silently makes it eager again.


## Libraries loaded on demand
Inside a library, the same idea is a dynamic `import()`. The rich-text editor of `@blouppy/ui` draws mermaid diagrams, and mermaid is the largest dependency in the tree. It loads the first time a diagram is drawn:

```ts
import type { Mermaid } from 'mermaid';

let mermaidLoader: Promise<Mermaid> | null = null;

function loadMermaid(): Promise<Mermaid> {
  mermaidLoader ??= import('mermaid').then(module => module.default);

  return mermaidLoader;
}
```

`import type` is erased at compile time, so the file names the type without bundling the library. The promise is cached, so ten diagrams start one download. Mermaid ends up in dozens of lazy chunks, the 1.47 MB `elk` layout engine among them.

Importing *less* of a library helps too. `@blouppy/ui/chart` registers only the Chart.js controllers it draws, not `registerables`, so tree shaking drops the rest. And a dependency in `package.json` costs nothing until something imports it: the Starter's app never imports the chart, and no chunk holds a byte of Chart.js.


## When it is not worth it
Every split is a round trip at the moment it is needed. A skeleton hides it, but there is a short wait an eager build would not have. Deferring a 5 kB component trades that wait for almost nothing. `@defer` pays off when what it hides is large: an editor, a chart, a map. And splits are invisible in review. A one-line import in the wrong file merges two chunks and passes every test, which is why the budget matters more than any single split.

Layout is the other thing a unit test cannot see; the [Playwright gallery of every page](/blog/2026-08-14-visual-review-for-an-angular-app-with-playwright/) reads the same build output.


## References
- [Configuring size budgets](https://angular.dev/tools/cli/build#configuring-size-budgets) — Angular: the budget types and thresholds.
- [Deferred loading with @defer](https://angular.dev/guide/templates/defer) — Angular: triggers, prefetching and the conditions for a dependency to be deferred.
- [Bundle Size Analyzer](https://esbuild.github.io/analyze/) — esbuild: a treemap of the `stats.json` metafile.
- [Dynamic import()](https://developer.mozilla.org/docs/Web/JavaScript/Reference/Operators/import) — MDN: loading a module on demand.
