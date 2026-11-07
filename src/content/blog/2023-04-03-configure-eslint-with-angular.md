---
templateKey: 'blog-post'
title: 'Configure ESLint with Angular'
date: 2023-04-03T18:24:10.000Z
updated: 2026-11-07T09:00:00.000Z
author: Jimmy Boinembalome
authorimage: /img/jimmy.jpg
category: Angular
topic: 'Tooling'
illustration: 2
categorycolor: bg-red-100 text-red-800
featuredpost: true
featuredimage: /img/configure-eslint-with-angular.jpg
description: Add ESLint to an Angular 22 project with ng add angular-eslint, understand the generated flat config and lint and fix your TypeScript and templates.
tags:
  - Development
  - Angular
  - ESLint
---

> **Updated November 2026:** rewritten for Angular 22. The package is now simply `angular-eslint`, and `ng add` generates an ESLint flat config (`eslint.config.js`) instead of `.eslintrc.json`, so I explain that new file below.

[ESLint](https://eslint.org/) is a static code analyzer (a linter): it finds problems in JavaScript and TypeScript code that break the configured rules, and fixes many of them. Angular used to ship another linter, [TSLint](https://palantir.github.io/tslint/), which was [deprecated in 2019](https://blog.palantir.com/tslint-in-2019-1a144c2317a9) in favour of ESLint's TypeScript support. Angular removed TSLint in version 12.

In this article, we add **ESLint** to an **Angular 22** project. It is the second article of a series that starts with [Configure Prettier with Angular](https://www.blouppy.com/blog/2023-01-29-configure-prettier-with-angular/).

## Prerequisites
- [Node.js](https://nodejs.org/en/): Angular 22 requires `^22.22.3`, `^24.15.0` or `^26.0.0` (see [Version compatibility](https://angular.dev/reference/versions)).
- [Angular CLI](https://angular.dev/tools/cli): `npm install -g @angular/cli`.
- An editor. I use [Visual Studio Code](https://code.visualstudio.com/).

## Create an Angular project
Create a project as in [the previous article](https://www.blouppy.com/blog/2023-01-29-configure-prettier-with-angular/#create-an-angular-project) (CSS, no SSR, no AI tools):
```bash
ng new angular-eslint
cd angular-eslint
```

A new Angular project still has no linter (it has a Prettier configuration, though).

## Install ESLint
Add [angular-eslint](https://github.com/angular-eslint/angular-eslint) with the Angular CLI:
```bash
ng add angular-eslint
```

> **_Note:_** In the first version of this article, the command was `ng add @angular-eslint/schematics`. Today, the single `angular-eslint` package brings the builder, the schematics, the ESLint plugins and the template parser together.

The CLI asks you to confirm the installation. It then installs the dependencies, detects a single project without a linter and wires everything up:
```text
✔ Determining Package Manager
› Found compatible package version: 22.6.0.
✔ Installing package
    angular-eslint v22 matches this workspace's Angular v22.
    ...
    We detected that you have a single project in your workspace and no existing linter wired up, so we are configuring ESLint for you automatically.
    ...
CREATE eslint.config.js (1004 bytes)
UPDATE package.json (934 bytes)
UPDATE angular.json (2211 bytes)
√ Packages installed successfully.
```

Here is what changed:
- **package.json**: a `"lint": "ng lint"` script and four devDependencies: `angular-eslint` (22, for Angular 22), `eslint`, `@eslint/js` and `typescript-eslint`.
- **angular.json**: a `lint` target that runs the `@angular-eslint/builder:lint` builder on `src/**/*.ts` and `src/**/*.html`. That is what makes [`ng lint`](https://angular.dev/cli/lint) work.
- **eslint.config.js**: the ESLint configuration.

## The eslint.config.js file
Since ESLint 9, the default format is the [flat config](https://eslint.org/docs/latest/use/configure/configuration-files): one JavaScript file, `eslint.config.js`, that exports an array of configuration objects. It replaces the `.eslintrc.json` file of the first version of this article. Here is the file `ng add` generates:
```js
// @ts-check
const eslint = require('@eslint/js');
const { defineConfig } = require('eslint/config');
const tseslint = require('typescript-eslint');
const angular = require('angular-eslint');

module.exports = defineConfig([
  {
    files: ['**/*.ts'],
    extends: [
      eslint.configs.recommended,
      tseslint.configs.recommended,
      tseslint.configs.stylistic,
      angular.configs.tsRecommended,
    ],
    processor: angular.processInlineTemplates,
    rules: {
      '@angular-eslint/directive-selector': [
        'error',
        {
          type: 'attribute',
          prefix: 'app',
          style: 'camelCase',
        },
      ],
      '@angular-eslint/component-selector': [
        'error',
        {
          type: 'element',
          prefix: 'app',
          style: 'kebab-case',
        },
      ],
    },
  },
  {
    files: ['**/*.html'],
    extends: [angular.configs.templateRecommended, angular.configs.templateAccessibility],
    rules: {},
  },
]);
```

Let's read it:
- `// @ts-check` and `defineConfig(...)`: the editor type-checks the configuration, so a typo in an option is underlined.
- The first object applies to the **TypeScript files** (`files: ['**/*.ts']`):
  - `extends` stacks the recommended rules of ESLint (`@eslint/js`), of [typescript-eslint](https://typescript-eslint.io/getting-started) (`recommended` and `stylistic`) and of Angular (`tsRecommended`).
  - `processor: angular.processInlineTemplates` extracts inline templates (`template: '...'` in a component) so they are linted like `.html` files.
  - `rules` sets the selector conventions: components are `app-something` elements and directives are `appSomething` attributes. The `app` prefix is the `prefix` of the project in **angular.json**.
- The second object applies to the **templates** (`files: ['**/*.html']`): the recommended template rules and the **accessibility** rules (an `<img>` without `alt`, a `click` without a keyboard event…).

To add or change a rule, add it to the `rules` of the right object, for example `'@typescript-eslint/no-explicit-any': 'off'`.

## Analyze files
Run ESLint on the project:
```text
$ ng lint
Linting "angular-eslint"...

All files pass linting.
```

Templates are analyzed too. For example, if I add `<img src="favicon.ico" />` at the end of **app.html**, the accessibility rules catch it:
```text
Linting "angular-eslint"...

~/angular-eslint/src/app/app.html
  354:1  error  <img/> element must have a text alternative  @angular-eslint/template/alt-text

✖ 1 problem (1 error, 0 warnings)

Lint errors found in the listed files.
```

## Fix files
Many rules can fix the code themselves with `ng lint --fix`. Let's add a small method to **app.ts**:
```ts
export class App {
  protected readonly title = signal('angular-eslint');

  protected sayHello(): string {
    let hello = 'Hello';
    return `${hello}, ${this.title()}!`;
  }
}
```

`ng lint` reports a [`prefer-const`](https://eslint.org/docs/latest/rules/prefer-const) error that it can fix:
```text
Linting "angular-eslint"...

~/angular-eslint/src/app/app.ts
  14:9  error  'hello' is never reassigned. Use 'const' instead  prefer-const

✖ 1 problem (1 error, 0 warnings)
  1 error and 0 warnings potentially fixable with the `--fix` option.

Lint errors found in the listed files.
```

`ng lint --fix` then reports "All files pass linting." and replaces `let` with `const`:
```diff
-    let hello = 'Hello';
+    const hello = 'Hello';
```

## VS Code extension
The [ESLint extension](https://marketplace.visualstudio.com/items?itemName=dbaeumer.vscode-eslint) (`dbaeumer.vscode-eslint`) shows the problems directly in the editor. Install it from the Extensions view (Ctrl+Shift+X on Windows and Linux, Cmd+Shift+X on macOS): it detects `eslint.config.js` automatically.

To [recommend it](https://code.visualstudio.com/docs/configure/extensions/extension-marketplace) to everyone who opens the project, add it to the **.vscode/extensions.json** file generated by the CLI:
```json
{
  // For more information, visit: https://go.microsoft.com/fwlink/?linkid=827846
  "recommendations": ["angular.ng-template", "dbaeumer.vscode-eslint"]
}
```

## Conclusion
In this article, we added ESLint to an Angular project with `ng add angular-eslint`, read the generated `eslint.config.js`, analyzed the code with `ng lint` and fixed it with `ng lint --fix`.

To run ESLint and Prettier automatically before each commit, read the last article of the series: [Configure Husky with Angular](https://www.blouppy.com/blog/2023-05-14-configure-husky-with-angular/).

Source code of the article: [GitHub source code](https://github.com/jboinembalome/angular-eslint)

## References
- [angular-eslint](https://github.com/angular-eslint/angular-eslint) — the Angular builder, schematics, plugins and template parser for ESLint.
- [ESLint: Configuration files](https://eslint.org/docs/latest/use/configure/configuration-files) — the flat config format, `files`, `extends` and `rules`.
- [ESLint: Configuration migration guide](https://eslint.org/docs/latest/use/configure/migration-guide) — moving from `.eslintrc` to `eslint.config.js`.
- [ESLint: prefer-const](https://eslint.org/docs/latest/rules/prefer-const) — the rule fixed in this article.
- [typescript-eslint: Getting started](https://typescript-eslint.io/getting-started) — the TypeScript parser and the `recommended` and `stylistic` configs.
- [Angular CLI: ng lint](https://angular.dev/cli/lint) — the `lint` command and its options.
- [Angular: Version compatibility](https://angular.dev/reference/versions) — the Node.js versions Angular 22 supports.
- [VS Code: Workspace recommended extensions](https://code.visualstudio.com/docs/configure/extensions/extension-marketplace) — `.vscode/extensions.json`.
- [ESLint extension for VS Code](https://marketplace.visualstudio.com/items?itemName=dbaeumer.vscode-eslint) — the editor integration.
- [TSLint in 2019](https://blog.palantir.com/tslint-in-2019-1a144c2317a9) — the deprecation announcement of TSLint.
