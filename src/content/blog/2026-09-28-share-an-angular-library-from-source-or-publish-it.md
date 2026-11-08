---
templateKey: 'blog-post'
title: 'Share an Angular library from source, or publish it'
date: 2026-09-28T09:00:00.000Z
author: Jimmy Boinembalome
authorimage: /img/jimmy.jpg
category: Angular
topic: 'Tooling'
illustration: 2
categorycolor: bg-red-100 text-red-800
featuredpost: true
description: >-
  Share one Angular library between several apps: consume it as source through an npm workspace, or build it with ng-packagr and publish it, and what each choice costs.
tags:
  - Development
  - Angular
  - TypeScript
  - Architecture
---

A second Angular app always arrives: a marketing site, a documentation site, a harness for the components. The first one already has a button, a dialog and a theme, and nobody wants to copy them. So they move into a library, and a question comes with it: does each app read the library's source, or does the library get built and published like any package from npm?

In this article, we will compare the two. We will set up a library consumed **as source** through an npm workspace, which is what [Blouppy Starter](https://starter.blouppy.com/) does for its four front-end apps, then look at the alternative: **building** it with ng-packagr and **publishing** it with a version. For each, we will see what it costs and when it stops being enough.


## Two ways to share a library
Both start from the same folder of components. The difference is what the app imports:

- **From source.** The app imports the library's `.ts` files and compiles them with its own code, as if they were in its tree. There is no build step for the library and no version: every app sees the commit it is on.
- **Published.** The library is compiled on its own into the Angular Package Format, given a version number and pushed to a registry. The app installs that version like `@angular/cdk` and never sees the source.

The first is a monorepo choice. The second is the only one that works across repositories.


## Consuming a library as source
Three pieces make it work. An npm workspace links the library into `node_modules`:

```json
{
  "name": "my-workspace",
  "private": true,
  "workspaces": ["app-one", "app-two", "libs/*"]
}
```

The library has a `package.json` of its own, with a name the apps can depend on:

```json
{
  "name": "@acme/ui",
  "version": "0.1.0",
  "private": true,
  "peerDependencies": {
    "@angular/core": "^22.0.0"
  }
}
```

And each app maps the import to the source in its `tsconfig.json`:

```json
{
  "compilerOptions": {
    "paths": {
      "@acme/ui/*": ["../libs/ui/src/*/index.ts"]
    }
  }
}
```

After `npm install` at the root, `node_modules/@acme/ui` is a link to `libs/ui`, and `import { ButtonDirective } from '@acme/ui/button'` compiles the library's file with the app's compiler, in the app's build. `"private": true` is a safety net: npm refuses to publish a private package, so nobody pushes it by mistake.


## How the Starter does it
The Starter's `front/` folder is the workspace root. Its manifest lists the four apps and every library under `libs/`:

```json
{
  "name": "blouppy-workspace",
  "private": true,
  "workspaces": ["application", "landing", "docs", "playground", "libs/*"]
}
```

`@blouppy/ui` is the design system: the tokens, the theme and every UI primitive. Its manifest has two fields that matter here:

```json
{
  "name": "@blouppy/ui",
  "version": "0.1.0",
  "private": true,
  "sideEffects": false,
  "exports": {
    "./tokens.css": "./src/tokens/tokens.css",
    "./tailwind.css": "./src/tokens/tailwind.css",
    "./*": {
      "types": "./src/*/index.ts",
      "default": "./src/*/index.ts"
    }
  },
  "dependencies": {
    "@angular/cdk": "^22.0.0",
    "chart.js": "^4.5.1"
  },
  "peerDependencies": {
    "@angular/common": "^22.0.0",
    "@angular/core": "^22.0.0",
    "@angular/forms": "^22.0.0"
  }
}
```

`exports` declares the public surface. The stylesheets are named one by one, and the `./*` pattern turns every folder of `src/` into an entry point, so `@blouppy/ui/button` resolves to `src/button/index.ts`. There is no root barrel on purpose: every import names the area it comes from, and an app that never imports `@blouppy/ui/chart` never reaches `chart.js`. `"sideEffects": false` tells the bundler that a module of the library does nothing when it is imported, so an unused one can be dropped.

The split between `dependencies` and `peerDependencies` follows who owns the instance. `@angular/core` and `@angular/common` must be the app's own copy, so they are peers. The CDK is used by the library itself, for its dialogs and overlays, so it is a plain dependency the apps do not have to declare.

Each app's `tsconfig.json` points at the source, with a comment saying why:

```json
{
  "compilerOptions": {
    // The shared library is consumed as source, so it is compiled by each app
    // rather than built separately.
    "paths": {
      "@blouppy/ui/*": ["../libs/ui/src/*/index.ts"]
    }
  }
}
```

And each app declares it like any other package, `"@blouppy/ui": "^0.1.0"`. The range is never checked against a registry: the lockfile records the package as a link.

```json
"node_modules/@blouppy/ui": {
  "resolved": "libs/ui",
  "link": true
}
```

In the apps, the TypeScript and the stylesheets go through the same package name:

```ts
import { LogoComponent } from '@blouppy/ui/brand';
import { ThemeSelectComponent, ThemeService } from '@blouppy/ui/theme';
```

```scss
@import 'tailwindcss';
@import '@blouppy/ui/tokens.css';
@import '@blouppy/ui/tailwind.css';
```

The library's CI job is short as a result. It only runs the lint and the formatting check: whether the library compiles is answered by the app jobs, which compile it, and they run whenever `front/libs/**` changes.


## What source sharing costs
**No build step, and no version skew.** A change to a button and the pages that use it land in one pull request, and every app builds against it at once. There is no "bump the library, publish, update four apps" loop, and no app left two versions behind.

**One lockfile.** The whole front end resolves from `front/package-lock.json`, so the four apps get the same Angular, the same CDK and the same Tailwind. A duplicated `@angular/core`, the classic failure of a linked library with its own `node_modules`, cannot happen. The price is that an upgrade of Angular is an upgrade of every app at once.

**Breaking changes are cheap but immediate.** Renaming an input breaks every app in the same commit, which is good: the compiler shows every call site. But nothing protects an app from a change it did not ask for, and a large team cannot "stay on the old version for a sprint".

**Every app compiles the library.** Four apps compile the same components four times, and the library is held to each app's compiler options. In practice that means the library is written to the strictest of them.

**The tools only see the app's tree.** Two traps showed up in the Starter. Tailwind 4 detects the classes an app uses by scanning its sources, and the library is outside each app's folder, so a utility used only in a library component went missing. Every app now declares the library explicitly:

```scss
// The library is consumed as source and lives outside this app's own tree, so
// Tailwind's automatic source detection never sees it.
@source '../../libs/ui/src/**/*.ts';
```

The second: an incremental build was observed serving a stale stylesheet after a class changed in the library, until the Angular cache (`front/.angular`) was cleared. The build, the lint and the tests all passed. This is what a visual check catches, as in our [visual review with Playwright](/blog/2026-08-14-visual-review-for-an-angular-app-with-playwright/).

**The Docker build context grows.** An image of one app needs the workspace root, every workspace manifest for `npm ci` and the library's folder. The Starter's Dockerfiles build from `front/` for that reason:

```dockerfile
COPY package.json package-lock.json ./
COPY application/package.json application/package.json
COPY landing/package.json landing/package.json
COPY docs/package.json docs/package.json
COPY playground/package.json playground/package.json
COPY libs libs

RUN npm ci

COPY landing landing
RUN npm run build --workspace landing
```


## Building and publishing instead
The other route is the one Angular's own libraries take. `ng generate library` creates a project built by [ng-packagr](https://github.com/ng-packagr/ng-packagr), configured by an `ng-package.json`:

```json
{
  "$schema": "../../node_modules/ng-packagr/ng-package.schema.json",
  "dest": "../../dist/ui",
  "lib": {
    "entryFile": "src/public-api.ts"
  }
}
```

`ng build ui` writes the Angular Package Format into `dist/ui`: compiled JavaScript, type declarations and a generated `package.json`. A published library is compiled in partial mode, and the app's build links it to its own Angular version. Secondary entry points such as `@acme/ui/button` are folders with an `ng-package.json` of their own.

Then the package needs a version and a registry:

- **npm** for a public package, or **GitHub Packages** (`npm.pkg.github.com`) for one shared inside an organization. GitHub Packages only accepts scoped names, and every consumer needs an `.npmrc` that maps the scope to the registry and a token that can read it.
- **A version policy.** [Changesets](https://github.com/changesets/changesets) has each pull request add a small file naming the bump (patch, minor, major) and the changelog line; a release step applies them. [semantic-release](https://github.com/semantic-release/semantic-release) derives the version from conventional commit messages instead. Either way, a breaking change becomes a major version that consumers adopt on their own schedule.

A minimal publishing workflow on GitHub Actions builds the library and publishes `dist/ui`, with provenance:

```yaml
name: Publish @acme/ui
on:
  release:
    types: [published]

permissions:
  contents: read
  id-token: write   # required for the provenance statement

jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - uses: actions/setup-node@v7
        with:
          node-version: 24
          registry-url: https://registry.npmjs.org
      - run: npm ci
      - run: npx ng build ui
      - run: npm publish --provenance --access public
        working-directory: dist/ui
        env:
          NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}
```

`--provenance` asks npm to record which repository, commit and workflow built the package, so a consumer can check where it came from. It needs the `id-token: write` permission. npm's trusted publishing goes one step further and lets the workflow publish through that same OpenID Connect token, with no long-lived secret to store. With Changesets, the release step is usually `changesets/action`, which opens a "Version packages" pull request and publishes once it is merged.


## What publishing costs
**A build before every use.** Changing a component and checking it in an app means building the library, then linking or installing it. Tools exist for the local loop, but the loop is longer.

**Version skew is the point, and the cost.** Each app pins a version and moves when it is ready. That protects a team from a change it did not ask for, and it means maintaining several versions in the wild, with a changelog, deprecations before removals, and fixes backported when an old major is still in use.

**Peer dependency ranges become a contract.** The library declares the Angular versions it supports, and an Angular upgrade means a release of the library before the apps can follow.

**Several lockfiles.** Each consumer resolves the library's dependencies in its own lockfile, so two apps can end up on two different CDK versions.

What it gives in return is reach. A published package works in any repository, for any team, and for consumers you do not know.


## When to choose which
Source sharing is enough, and simpler, when every consumer lives in the same repository and is released by the same team. That is the Starter's case: four apps, one design system, one pull request for a change, and a playground that documents every primitive.

Publishing becomes necessary as soon as:

- an app in **another repository** needs the library;
- **external consumers** use it, whether customers, partners or the open source community;
- teams need to **adopt changes at their own pace**, and a breaking change must wait for them.

There is also a middle ground worth avoiding: building the library with ng-packagr inside the monorepo, then consuming its `dist/` from the apps. It pays the build step without the benefit of versions.


## Conclusion
Sharing an Angular library from source is three small files: a workspace manifest, a library `package.json` with `exports`, and a `paths` entry per app. It removes the build step and the version skew, and the single lockfile keeps every app on the same Angular. The costs are a library compiled by every app, tools that need to be told it exists, such as Tailwind's `@source`, and breaking changes that land everywhere at once. Publishing with ng-packagr, a version policy and a provenance-signed workflow is the right move once the library leaves the repository. Until then, the source is the simpler contract.


## References
- [npm workspaces (npm Docs)](https://docs.npmjs.com/cli/using-npm/workspaces) — linking local packages from one root manifest and one lockfile.
- [Package entry points: exports (Node.js)](https://nodejs.org/api/packages.html#package-entry-points) — the `exports` field and subpath patterns.
- [TypeScript: paths](https://www.typescriptlang.org/tsconfig/#paths) — mapping an import to a source file.
- [webpack: sideEffects](https://webpack.js.org/guides/tree-shaking/#mark-the-file-as-side-effect-free) — what `"sideEffects": false` tells a bundler.
- [Creating libraries (Angular)](https://angular.dev/tools/libraries/creating-libraries) — `ng generate library`, building and publishing.
- [Angular Package Format (Angular)](https://angular.dev/tools/libraries/angular-package-format) — what ng-packagr produces.
- [ng-packagr (GitHub)](https://github.com/ng-packagr/ng-packagr) — the library builder and its `ng-package.json`.
- [Generating provenance statements (npm Docs)](https://docs.npmjs.com/generating-provenance-statements) — `npm publish --provenance` from GitHub Actions.
- [Trusted publishing (npm Docs)](https://docs.npmjs.com/trusted-publishers) — publishing through OpenID Connect without a token.
- [Working with the npm registry (GitHub Docs)](https://docs.github.com/packages/working-with-a-github-packages-registry/working-with-the-npm-registry) — publishing and installing from GitHub Packages.
- [Changesets (GitHub)](https://github.com/changesets/changesets) — versions and changelogs from per-change files.
- [semantic-release (GitHub)](https://github.com/semantic-release/semantic-release) — versions from commit messages.
- [Tailwind CSS: detecting classes in source files](https://tailwindcss.com/docs/detecting-classes-in-source-files) — the `@source` directive.
