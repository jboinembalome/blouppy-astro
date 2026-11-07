---
templateKey: 'blog-post'
title: 'Configure Prettier with Angular'
date: 2023-01-29T18:24:10.000Z
updated: 2026-11-07T09:00:00.000Z
author: Jimmy Boinembalome
authorimage: /img/jimmy.jpg
category: Angular
topic: 'Tooling'
illustration: 1
categorycolor: bg-red-100 text-red-800
featuredpost: true
featuredimage: /img/configure-prettier-with-angular.jpg
description: Configure the Prettier that the Angular CLI installs, format Angular templates with the angular parser, ignore files and add format scripts.
tags:
  - Development
  - Angular
  - Prettier
---

> **Updated November 2026:** rewritten for Angular 22 and Prettier 3. The Angular CLI now installs Prettier for you, so this article is about configuring it. I also fixed two option names that Prettier was silently ignoring (`useTabs` and `semi`) and added the `angular` parser for templates.

In a team, code style drifts: one developer uses single quotes and tabs, another double quotes and spaces. A written convention helps, but people forget it. A formatter such as [Prettier](https://prettier.io/) applies the rules for everyone, automatically.

In this article, we configure **Prettier** in an **Angular 22** project. It is the first article of a series: [Configure ESLint with Angular](https://www.blouppy.com/blog/2023-04-03-configure-eslint-with-angular/) adds a linter, and [Configure Husky with Angular](https://www.blouppy.com/blog/2023-05-14-configure-husky-with-angular/) runs both before each commit.

## Prerequisites
- [Node.js](https://nodejs.org/en/): Angular 22 requires an active or maintenance LTS version: `^22.22.3`, `^24.15.0` or `^26.0.0` (see [Version compatibility](https://angular.dev/reference/versions)).
- [Angular CLI](https://angular.dev/tools/cli): `npm install -g @angular/cli`.
- An editor. I use [Visual Studio Code](https://code.visualstudio.com/).

## Create an Angular project
Create a new project with the Angular CLI:
```bash
ng new angular-prettier
```

The CLI asks a few questions. I chose CSS, no server-side rendering and no AI tools. The first file it creates is worth a look:
```text
√ Which stylesheet system would you like to use? CSS             [ https://developer.mozilla.org/docs/Web/CSS ]
√ Do you want to enable Server-Side Rendering (SSR) and Static Site Generation (SSG/Prerendering)? No
√ Which AI tools should Angular integrate with? https://angular.dev/ai/develop-with-ai None
CREATE angular-prettier/.prettierrc (161 bytes)
CREATE angular-prettier/README.md (1468 bytes)
...
√ Packages installed successfully.
    Successfully initialized git.
```

Then open the project:
```bash
cd angular-prettier
code .
```

## Prettier is already installed
Recent versions of the Angular CLI add Prettier to every new project. `ng new` puts it in the **devDependencies** of **package.json**:
```json
"devDependencies": {
  "prettier": "^3.8.1"
}
```

And it generates this **.prettierrc**:
```json
{
  "printWidth": 100,
  "singleQuote": true,
  "overrides": [
    {
      "files": "*.html",
      "options": {
        "parser": "angular"
      }
    }
  ]
}
```

If your project was created with an older CLI, [install Prettier](https://prettier.io/docs/install) yourself as a development dependency (the application does not need it at runtime):
```bash
npm install prettier --save-dev
```

## Configure Prettier
The **.prettierrc** file at the root of the project tells editors and other tools that the project uses Prettier, and with which [configuration](https://prettier.io/docs/configuration). Let's extend the generated one with the rules of our team:
```json
{
  "printWidth": 100,
  "tabWidth": 2,
  "useTabs": false,
  "singleQuote": true,
  "semi": true,
  "quoteProps": "preserve",
  "bracketSpacing": false,
  "overrides": [
    {
      "files": "*.html",
      "options": {
        "parser": "angular"
      }
    }
  ]
}
```

The [options](https://prettier.io/docs/options):
- `printWidth`: the line length at which Prettier wraps.
- `tabWidth`: the number of spaces per indentation level.
- `useTabs`: indent with tabs instead of spaces.
- `singleQuote`: use single quotes instead of double quotes.
- `semi`: print semicolons at the end of statements.
- `quoteProps`: keep the quotes of object properties as written.
- `bracketSpacing`: print spaces between brackets in object literals (`false` gives `{Component}` instead of `{ Component }`).
- `overrides`: format the `*.html` files with the `angular` parser.

`tabWidth: 2`, `useTabs: false` and `semi: true` are the defaults; writing them down documents the team's choice.

Check the option names carefully. The first version of this article used `tabs` and `semicolon`, which are not Prettier options. Prettier 3 says so, then applies its defaults:
```text
Checking formatting...
[warn] Ignored unknown option { tabs: false }.
[warn] Ignored unknown option { semicolon: true }.
[warn] src/app/app.ts
[warn] Code style issues found in the above file. Run Prettier with --write to fix.
```

### Why the `angular` parser?
Prettier infers the `angular` parser only for files named `*.component.html`. Following the current [style guide](https://angular.dev/style-guide), the Angular CLI names its files `app.html`, `app.ts`… without the `.component` suffix. Without the override, a template is formatted as plain HTML and the control flow blocks (`@if`, `@for`…) are not indented. Take this messy template:
```html
@if (items().length > 0) {
<ul>
@for (item of items(); track item.id) {<li>{{ item.name }}</li>}
</ul>
} @else {<p>No items</p>}
```

With the `html` parser:
```html
@if (items().length > 0) {
<ul>
  @for (item of items(); track item.id) {
  <li>{{ item.name }}</li>
  }
</ul>
} @else {
<p>No items</p>
}
```

With the `angular` parser:
```html
@if (items().length > 0) {
  <ul>
    @for (item of items(); track item.id) {
      <li>{{ item.name }}</li>
    }
  </ul>
} @else {
  <p>No items</p>
}
```

> **_Note:_** Since [Prettier 3](https://prettier.io/blog/2023/07/05/3.0.0), the default value of `trailingComma` is `"all"`: Prettier adds a trailing comma wherever possible in multi-line code, function arguments included. That is why the code generated by the CLI ends its multi-line objects with a comma. Set `"trailingComma": "es5"` or `"none"` if your team prefers.

## Ignore files
A [**.prettierignore**](https://prettier.io/docs/ignore) file tells Prettier which files not to format. Create it at the root of the project:
```text
dist
.angular
coverage
package-lock.json
```

`dist` is the build output, `.angular` the Angular CLI cache and `coverage` the code coverage report.

> **_Note:_** By default, Prettier ignores version control directories (`.git`, `.jj`, `.sl`, `.svn`, `.hg`) and `node_modules`. It also follows the rules of the **.gitignore** file of the directory it runs from.

## Check files
To check the formatting of every file (except the ignored ones), use the [CLI](https://prettier.io/docs/cli):
```bash
npx prettier --check .
```

`npx` runs the Prettier installed in the project's `node_modules`, so everyone uses the same version. You can also pass a glob, for example `npx prettier --check "src/app/**/*.{ts,html}"`.

Let's add a script to the **scripts** section of **package.json** (inside an npm script, `npx` is not needed: npm finds the commands of `node_modules/.bin`):
```json
"format-check": "prettier --check ."
```

Then run it:
```text
$ npm run format-check

> angular-prettier@0.0.0 format-check
> prettier --check .

Checking formatting...
[warn] src/app/app.config.ts
[warn] src/app/app.html
[warn] src/app/app.routes.ts
[warn] src/app/app.spec.ts
[warn] src/app/app.ts
[warn] src/main.ts
[warn] Code style issues found in 6 files. Run Prettier with --write to fix.
```

These files were generated with `{ Component }`, and our configuration wants `{Component}`.

## Format files
To format the files, replace `--check` with `--write`, and add the matching script:
```json
"format": "prettier --write ."
```

```text
$ npm run format

> angular-prettier@0.0.0 format
> prettier --write .

.prettierrc 22ms (unchanged)
...
src/app/app.config.ts 35ms
src/app/app.html 112ms
src/app/app.routes.ts 2ms
src/app/app.spec.ts 13ms
src/app/app.ts 5ms
...
src/main.ts 3ms
```

In **app.ts**, the imports lose the spaces between their brackets:
```diff
-import { Component, signal } from '@angular/core';
-import { RouterOutlet } from '@angular/router';
+import {Component, signal} from '@angular/core';
+import {RouterOutlet} from '@angular/router';
```

The template is formatted too: in **app.html**, the objects inside the `@for` block become `{title: 'CLI Docs', link: 'https://angular.dev/tools/cli'}`, which shows that the `angular` parser also formats the expressions of the control flow.

> **_Note:_** If you also use ESLint, add [eslint-config-prettier](https://github.com/prettier/eslint-config-prettier) to your ESLint configuration. It turns off the ESLint rules that are unnecessary or might conflict with Prettier (see [Integrating with linters](https://prettier.io/docs/integrating-with-linters)). We do exactly that in [Configure Husky with Angular](https://www.blouppy.com/blog/2023-05-14-configure-husky-with-angular/).

## Conclusion
In this article, we configured the Prettier that the Angular CLI installs: team options in **.prettierrc**, the `angular` parser for templates, a **.prettierignore** file, and two scripts to check and format the code.

The next article of the series adds [ESLint](https://www.blouppy.com/blog/2023-04-03-configure-eslint-with-angular/) to an Angular project.

Source code of the article: [GitHub source code](https://github.com/jboinembalome/angular-prettier)

## References
- [Prettier: Options](https://prettier.io/docs/options) — every formatting option and its default.
- [Prettier: Configuration file](https://prettier.io/docs/configuration) — `.prettierrc` and `overrides`.
- [Prettier: Ignoring code](https://prettier.io/docs/ignore) — `.prettierignore` and the default ignored directories.
- [Prettier: CLI](https://prettier.io/docs/cli) — `--check` and `--write`.
- [Prettier: Install](https://prettier.io/docs/install) — installing Prettier locally.
- [Prettier 3.0 release notes](https://prettier.io/blog/2023/07/05/3.0.0) — the new `trailingComma` default.
- [Prettier: Integrating with linters](https://prettier.io/docs/integrating-with-linters) — using Prettier with ESLint.
- [eslint-config-prettier](https://github.com/prettier/eslint-config-prettier) — turns off the ESLint rules that conflict with Prettier.
- [Angular coding style guide](https://angular.dev/style-guide) — the file naming the CLI follows.
- [Angular: Version compatibility](https://angular.dev/reference/versions) — the Node.js versions Angular 22 supports.
