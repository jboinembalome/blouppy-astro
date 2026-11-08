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

An Angular app rarely gets heavy in one commit. A markdown editor arrives for one form, a charting library for one page, a diagram renderer because the editor can show diagrams. Each import is a single line, the build stays green, and one day the first page takes three seconds on a phone. Nobody chose that: nothing measured it.

In this article, we will measure what the build produces, hold the result with budgets in `angular.json`, and keep heavy code out of the first load with lazy routes, `@defer` blocks and dynamic `import()`. The real example is the front end of [Blouppy Starter](https://starter.blouppy.com/), with the sizes its production build reports.


## Measure first
The application builder (esbuild) prints a table at the end of every production build. Here is the one `ng build` gives for the Starter's app, trimmed:

```text
Initial chunk files | Names                            |  Raw size | Estimated transfer size
chunk-Bz1tJlP4.js   | -                                | 336.39 kB |                92.70 kB
main-IORZIGYL.js    | main                             | 271.61 kB |                64.16 kB
chunk-DF38mDGi.js   | -                                | 119.33 kB |                28.81 kB
styles-NJKPH5AF.css | styles                           |  84.81 kB |                13.63 kB
...
                    | Initial total                    | 863.72 kB |               211.51 kB

Lazy chunk files    | Names                            |  Raw size | Estimated transfer size
chunk-BQoEoLIv.js   | elk-276RUBZZ                     |   1.47 MB |               345.76 kB
chunk-DZcLD-qd.js   | assistant-conversation-component | 941.31 kB |               235.20 kB
chunk-ruWW7kYx.js   | organization-routes              | 211.07 kB |                37.13 kB
chunk-rbP0j56u2.js  | account-routes                   |  98.31 kB |                21.79 kB
...and 95 more lazy chunks files.
```

Two lines matter most. **Initial total** is what the browser downloads before the first page can render: here 864 kB raw, about 212 kB compressed. The **lazy chunks** are everything else, fetched only when something asks for them. The raw size is what the browser has to parse and execute, and the transfer size is an estimate of what goes over the network.

The table says how big a chunk is. It does not say what is in it. For that, `ng build --stats-json` writes `dist/stats.json`, an esbuild metafile that lists every input of every output. We can drop it into [esbuild's bundle analyzer](https://esbuild.github.io/analyze/) for a treemap, or read it with a few lines of Node:

```js
// analyse.mjs: which packages fill each chunk
import fs from 'node:fs';

const { outputs } = JSON.parse(fs.readFileSync('dist/stats.json', 'utf8'));
const packageOf = path => path.match(/node_modules\/((@[^/]+\/)?[^/]+)/)?.[1] ?? 'app';

for (const [file, output] of Object.entries(outputs)) {
  const sizes = {};
  for (const [input, { bytesInOutput }] of Object.entries(output.inputs ?? {})) {
    sizes[packageOf(input)] = (sizes[packageOf(input)] ?? 0) + bytesInOutput;
  }
  console.log(file, Object.entries(sizes).sort((a, b) => b[1] - a[1]).slice(0, 5));
}
```

On the Starter, this answers the questions the table leaves open. The largest initial chunk is the framework: `@angular/core`, `@angular/router`, `@angular/common`, RxJS and Transloco. `main` holds the app's shell, the part of `@blouppy/ui` the shell uses, the Angular CDK and `@angular/animations`. The 941 kB lazy chunk is tiptap, ProseMirror, lowlight and the markdown parser. And of the 117 JavaScript files the build writes, 71 belong to mermaid and the libraries it pulls in.

If we prefer to read sizes from source maps, `ng build --source-map` followed by `npx source-map-explorer dist/browser/*.js` gives the same picture per file. The production configuration turns source maps off, so the flag is needed.


## Budgets in angular.json
Measuring once is a snapshot. A **budget** turns the number into a check that runs on every build. Budgets live in the production configuration of `angular.json`:

```json
"budgets": [
  { "type": "initial", "maximumWarning": "900kB", "maximumError": "1MB" },
  { "type": "anyComponentStyle", "maximumWarning": "6kB" }
]
```

`initial` measures the initial total, `anyComponentStyle` each component's styles, and other types cover any script (`anyScript`), all scripts (`allScript`) or a named bundle (`bundle`). Past `maximumWarning`, the build prints a warning; past `maximumError`, it fails. The sizes compared are the raw ones, the third column of the table.

The Starter's `angular.json` declares only the second line, a 6 kB warning on component styles. The first one is what we would add, set a little above today's 864 kB: high enough to pass now, low enough that the next 150 kB of eager code fails the build and gets a conversation. A budget set far above the current size never fires, and a warning nobody reads is not a budget. Setting `maximumError` is what makes CI enforce it.


## Lazy routes with loadChildren and loadComponent
The cheapest split is the router. A route that names its component with `loadComponent`, or its child routes with `loadChildren`, becomes its own chunk:

```ts
export const appRoutes: Route[] = [
  { path: 'pricing', loadChildren: () => import('./features/pricing/pricing.routes') },
  {
    path: '',
    component: LayoutComponent,
    children: [
      { path: 'account', loadChildren: () => import('./features/account/account.routes') },
      { path: 'notifications', loadChildren: () => import('./features/notifications/notifications.routes') },
      {
        path: 'forbidden',
        loadComponent: () => import('./features/error/forbidden/forbidden.component').then(c => c.ForbiddenComponent),
      },
      { path: ':organizationSlug', loadChildren: () => import('./features/organization/organization-scope.routes') },
    ],
  },
];
```

This is the Starter's root routing, trimmed. A routes file with a `default` export needs no `.then()`. Only the layout and the components the root routes name directly are eager; every feature (account, notifications, organization settings, workspaces, checkout, pricing) is a lazy chunk. That is where `organization-routes` (211 kB) and `account-routes` (98 kB) in the table come from.

The rule that keeps the split working is simple: **nothing eager may import from a lazy feature**. One `import { SomeHelper } from 'app/features/account/...'` in the layout pulls that file, and whatever it imports, back into the initial chunks. The build does not complain; only the table changes.

The Starter also registers `withPreloading(PreloadAllModules)`. Once the first page is up, the router downloads every lazy route in the background, so the next navigation does not wait for the network. Lazy routes therefore keep the features out of the **first** load, but a visitor still downloads them shortly after. That is a fair trade for an app people stay in for a while. It is also why a heavy library must not ride on a lazy route alone if most visitors never need it.


## @defer for a heavy component inside an eager page
Some heavy code sits inside a page that is already loaded. The Starter's assistant panel lives in the layout, so it is eager, and it renders answers as markdown through `ui-rich-text-view`, which is built on tiptap. Importing that view statically would put tiptap, ProseMirror and a syntax highlighter into `main`.

A `@defer` block tells the compiler to move what it renders into a separate chunk:

```ts
@Component({
  selector: 'app-assistant-panel',
  imports: [AssistantConversationComponent, SkeletonComponent, EmptyStateComponent],
  template: `
    @if (assistant.entries().length === 0) {
      <ui-empty-state icon="pi pi-sparkles" [heading]="'assistant.empty.heading' | transloco" />
    } @else {
      @defer (on immediate) {
        <app-assistant-conversation [entries]="assistant.entries()" />
      } @placeholder {
        <ui-skeleton height="6rem" />
      }
    }
  `,
})
export class AssistantPanelComponent {}
```

`AssistantConversationComponent` renders `AssistantAnswerComponent`, which renders `RichTextViewComponent`. Because the conversation is used only inside the `@defer` block, the whole chain becomes the `assistant-conversation-component` chunk: 941 kB raw, 235 kB compressed, more than the entire initial load. A visitor who never opens the assistant never downloads it, and preloading does not fetch deferred chunks.

The trigger is `on immediate` because the block is already guarded: it only renders once a conversation has entries, so there is no reason to wait any longer. Other triggers fit other cases: `on viewport` for something below the fold, `on interaction` or `on hover` for something behind a click, `on idle` (the default), and `prefetch on idle` to download early but render later.

The split only happens under two conditions. The deferred dependencies must be standalone, and they must not be referenced anywhere else in the same file outside the block. Listing them in `imports` is fine. Naming one of them in a `viewChild()` query, or using it in a second, non-deferred place, silently makes it eager again.


## Heavy dependencies loaded on demand
Inside a library, the same idea is a dynamic `import()`. The rich-text editor of `@blouppy/ui` can render mermaid diagrams in code blocks, and mermaid is by far the largest dependency in the tree. It loads the first time a diagram is drawn:

```ts
import type { Mermaid } from 'mermaid';

let mermaidLoader: Promise<Mermaid> | null = null;

function loadMermaid(): Promise<Mermaid> {
  mermaidLoader ??= import('mermaid').then(module => module.default);

  return mermaidLoader;
}
```

Two details make it work. `import type` is erased at compile time, so the file can name the `Mermaid` type without bundling the library. And the promise is cached, so ten diagrams on a page start one download. The result is the 71 mermaid chunks in the build, the 1.47 MB `elk` layout engine among them, none of which loads until a diagram appears.

The charting component shows the other half: importing **less** of a library. Chart.js offers `Chart.register(...registerables)`, which registers every controller, scale and plugin it ships. `@blouppy/ui/chart` registers only the doughnut, bar and line controllers with the elements and scales they need, so tree shaking can drop the rest. It registers them on first use rather than at module load, because the library's `package.json` declares `"sideEffects": false`, and a registration at import time is exactly a side effect.

That flag also explains a line missing from the Starter's build: chart.js is in its dependencies, but the app never imports `@blouppy/ui/chart`, and no chunk contains a byte of chart.js. A dependency in `package.json` costs nothing until something imports it. A project-management app built on the Starter does import it, for its analytics page, and that page sits on its own lazy route, so the chart code stays out of the first load there too.


## What it costs
- **More requests, and a wait.** Every split is a round trip at the moment it is needed. A `@placeholder` or a skeleton hides it, but the first time someone opens a deferred panel, there is a short delay that an eager build would not have.
- **Splits are invisible in code review.** A one-line import in the wrong file merges two chunks and passes every test. Only the table, the analyzer or a budget sees it.
- **Hashed names are not stable.** Production builds disable `namedChunks`, so most chunks are `chunk-<hash>.js`. Comparing two builds means comparing what is inside them, through the metafile, not their file names.
- **Third-party warnings come with heavy libraries.** The Starter's build prints a dozen "is not ESM" warnings, all from mermaid's dependencies and one from `tiptap-markdown`. CommonJS modules are harder to tree shake, which is one more reason to keep them behind a dynamic import.


## When not to bother
- **An internal tool on a fast network.** If every user is on a desktop in the office and the initial load is a few hundred kilobytes, lazy routes and a budget are enough. `@defer` adds a placeholder state to design and test.
- **Small components.** Deferring a 5 kB component trades a round trip for almost nothing. `@defer` pays off when what it hides is large, like an editor, a chart or a map.
- **Before measuring.** Guessing which import is heavy is usually wrong. In the Starter, the analyzer showed `@angular/animations` among the largest inputs of `main`, registered by `provideAnimations()` in `app.config.ts`, while nothing in the app declares an animation trigger. That kind of finding only comes from looking.


## Conclusion
A small bundle comes from a habit kept on every build. `ng build --stats-json` and an analyzer say what each chunk holds, a budget with a `maximumError` keeps the initial total from creeping, lazy routes keep each feature in its own chunk, and `@defer` and dynamic `import()` keep heavy libraries out until someone needs them. In the Starter, the result is an initial load of 864 kB raw, about 212 kB compressed, while the editor and the diagram renderer, several megabytes between them, wait in lazy chunks.

If layout is the other thing a unit test cannot see, the [Playwright gallery of every page](/blog/2026-08-14-visual-review-for-an-angular-app-with-playwright/) covers it, and the same build output feeds both.

## References
- [Configuring size budgets (Angular)](https://angular.dev/tools/cli/build#configuring-size-budgets) — the budget types and thresholds in `angular.json`.
- [Lazy-loading routes (Angular)](https://angular.dev/guide/routing/define-routes) — `loadComponent` and `loadChildren`.
- [Deferred loading with @defer (Angular)](https://angular.dev/guide/templates/defer) — triggers, prefetching and the conditions for a dependency to be deferred.
- [Preloading strategies (Angular)](https://angular.dev/api/router/PreloadAllModules) — `PreloadAllModules` and `withPreloading`.
- [Bundle Size Analyzer (esbuild)](https://esbuild.github.io/analyze/) — a treemap of the `stats.json` metafile.
- [Metafile (esbuild)](https://esbuild.github.io/api/#metafile) — the format `--stats-json` writes.
- [source-map-explorer (npm)](https://www.npmjs.com/package/source-map-explorer) — sizes read from source maps.
- [Tree shaking in Chart.js (Chart.js)](https://www.chartjs.org/docs/latest/getting-started/integration.html) — registering only the controllers a chart uses.
- [Dynamic import() (MDN)](https://developer.mozilla.org/docs/Web/JavaScript/Reference/Operators/import) — loading a module on demand.
