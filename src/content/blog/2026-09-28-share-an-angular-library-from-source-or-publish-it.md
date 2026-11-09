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

A second Angular app always arrives: a marketing site, a documentation site, a harness for the components. The first app already has a button, a dialog and a theme, and nobody wants to copy them. So they move into a library, and a question comes with it. Does each app read the library's source, or does the library get built and published like any package from npm?


## Two ways to share
Both start from the same folder of components. The difference is what the app imports.

**From source**, the app imports the library's `.ts` files and compiles them with its own code. There is no build step for the library and no version: every app sees the commit it is on. **Published**, the library is compiled on its own into the Angular Package Format, given a version and pushed to a registry. The app installs that version like `@angular/cdk` and never sees the source.

The first is a monorepo choice. The second is the only one that works across repositories.


## Sharing from source
Three small files make it work. An npm workspace at the root links the library into `node_modules`. The library gets a `package.json` of its own. And each app maps the import to the source:

```json
// package.json, at the root
{ "private": true, "workspaces": ["app-one", "app-two", "libs/*"] }

// libs/ui/package.json
{ "name": "@acme/ui", "version": "0.1.0", "private": true, "peerDependencies": { "@angular/core": "^22.0.0" } }

// app-one/tsconfig.json
{ "compilerOptions": { "paths": { "@acme/ui/*": ["../libs/ui/src/*/index.ts"] } } }
```

After `npm install` at the root, `node_modules/@acme/ui` is a link to `libs/ui`. `import { ButtonDirective } from '@acme/ui/button'` compiles the library's file with the app's compiler, in the app's build. `"private": true` is a safety net: npm refuses to publish a private package.

[Blouppy Starter](https://starter.blouppy.com/) shares its design system, `@blouppy/ui`, this way between four apps. Its manifest adds two fields that matter, shown here trimmed:

```json
{
  "name": "@blouppy/ui",
  "private": true,
  "sideEffects": false,
  "exports": {
    "./tokens.css": "./src/tokens/tokens.css",
    "./*": { "types": "./src/*/index.ts", "default": "./src/*/index.ts" }
  }
}
```

`exports` declares the public surface. The `./*` pattern turns every folder of `src/` into an entry point, so `@blouppy/ui/button` resolves to `src/button/index.ts`. There is no root barrel on purpose. Every import names its area, and an app that never imports `@blouppy/ui/chart` never reaches Chart.js. `"sideEffects": false` lets the bundler drop a module nobody uses. The split between dependencies follows who owns the instance: `@angular/core` must be the app's own copy, so it is a peer; the CDK is the library's own, so it is a plain dependency.


## What source sharing costs
The gains are real. A change to a button and the pages that use it land in one pull request, and every app builds against it at once. There is no "bump, publish, update four apps" loop. And one lockfile means the four apps share one Angular and one CDK, so a duplicated `@angular/core` cannot happen. The price is that an Angular upgrade upgrades every app at once.

A breaking change is cheap but immediate. Renaming an input breaks every app in the same commit, and the compiler shows every call site. But no app can "stay on the old version for a sprint". Every app also compiles the library, so it must be written to the strictest app's compiler options.

The sneakiest cost is that tools only see the app's own tree. Tailwind 4 finds the classes an app uses by scanning its sources, and the library lives outside each app's folder. A utility used only in a library component went missing. Every app now declares the library, as in the landing page's stylesheet:

```scss
// The library lives outside this app's tree, so Tailwind's source detection never sees it.
@source '../../libs/ui/src/**/*.ts';
```

The build, the lint and the tests all passed while that class was missing. That is what a [visual review with Playwright](/blog/2026-08-14-visual-review-for-an-angular-app-with-playwright/) catches. Docker images grow too: building one app needs the workspace root, every workspace manifest for `npm ci`, and the library's folder.


## Building and publishing instead
The other route is the one Angular's own libraries take. `ng generate library` creates a project built by [ng-packagr](https://github.com/ng-packagr/ng-packagr). `ng build ui` writes the Angular Package Format into `dist/ui`: compiled JavaScript, type declarations and a `package.json`. Secondary entry points such as `@acme/ui/button` are folders with an `ng-package.json` of their own.

Then the package needs a version and a registry. npm for a public package, or GitHub Packages for one shared inside an organization. A tool such as [Changesets](https://github.com/changesets/changesets) has each pull request name its bump, so a breaking change becomes a major version that consumers adopt on their own schedule. The publishing workflow comes down to a few steps:

```yaml
permissions:
  contents: read
  id-token: write   # required for the provenance statement

steps:
  - run: npm ci
  - run: npx ng build ui
  - run: npm publish --provenance --access public
    working-directory: dist/ui
```

`--provenance` records which repository, commit and workflow built the package, so a consumer can check where it came from. With npm's trusted publishing, the workflow publishes through that same OpenID Connect token, with no long-lived secret to store.

Publishing costs a build before every use: checking a component in an app means building and installing the library first. Version skew is the point, and the cost. Each app moves when it is ready, which means old versions in the wild, a changelog, deprecations before removals and backported fixes. And each consumer has its own lockfile, so two apps can end up on two CDK versions. What it gives in return is reach: any repository, any team, consumers we do not know.


## Which one to choose
Source sharing is enough, and simpler, when every consumer lives in the same repository and ships with the same team. That is the Starter's case: four apps, one design system, one pull request per change.

Publishing becomes necessary when an app in **another repository** needs the library, when **external consumers** use it, or when teams must **adopt changes at their own pace**.

One middle ground is worth avoiding: building the library with ng-packagr inside the monorepo and consuming its `dist/`. It pays for the build step without the benefit of versions.


## References
- [npm workspaces](https://docs.npmjs.com/cli/using-npm/workspaces) — npm Docs: local packages from one root manifest and one lockfile.
- [Package entry points: exports](https://nodejs.org/api/packages.html#package-entry-points) — Node.js: the `exports` field and subpath patterns.
- [Creating libraries](https://angular.dev/tools/libraries/creating-libraries) — Angular: `ng generate library`, building and publishing.
- [Generating provenance statements](https://docs.npmjs.com/generating-provenance-statements) — npm Docs: `npm publish --provenance` from GitHub Actions.
