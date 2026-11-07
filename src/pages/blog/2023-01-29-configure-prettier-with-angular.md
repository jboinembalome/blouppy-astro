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
description: Quick steps to configure Prettier in an Angular project.
tags:
  - Development
  - Angular
  - Prettier
---

> **Updated November 2026:** rewritten for Angular 22 and Prettier 3. The Angular CLI now installs Prettier for you, so this article is about configuring it: I also fixed two option names that Prettier was silently ignoring (`useTabs` and `semi`) and added the `angular` parser for templates. 🙂

When we work in a team project, it is possible to encounter inconsistent code. Indeed, one developer may use single quotes and tabs and another developer may use double quotes and spaces. Even though there is documentation in the project with a naming convention, it is possible to forget some rules during our development.

To help us apply code formatting rules and therefore promote consistent code, we can use [Prettier](https://prettier.io/).

In this article, we will configure **Prettier** in an **Angular 22** project.

## Prerequisites
Before to start you will need:
- [Node.js](https://nodejs.org/en/): Angular **requires an active LTS (Long Term Support) or maintenance LTS version** of **Node.js** (for Angular 22: `^22.22.3`, `^24.15.0` or `>=26.0.0`).
- [Angular CLI](https://angular.dev/tools/cli): We will use the **Angular CLI** to create an Angular project.
- [Visual Studio Code](https://code.visualstudio.com/): The editor to open the project. (You can choose your favourite editor or IDE as well 🙂)


## Create an Angular project
Let's create a new project with the Angular CLI by running the following command in a terminal:
```bash
ng new angular-prettier
```
After running the command, Angular CLI will ask you few questions to configure your new Angular project. Here are my answers (CSS, no SSR, no AI tools) and what the CLI did next:
```text
√ Which stylesheet system would you like to use? CSS             [ https://developer.mozilla.org/docs/Web/CSS ]
√ Do you want to enable Server-Side Rendering (SSR) and Static Site Generation (SSG/Prerendering)? No
√ Which AI tools should Angular integrate with? https://angular.dev/ai/develop-with-ai None
CREATE angular-prettier/.prettierrc (161 bytes)
CREATE angular-prettier/README.md (1468 bytes)
CREATE angular-prettier/.editorconfig (314 bytes)
CREATE angular-prettier/.gitignore (622 bytes)
CREATE angular-prettier/angular.json (1933 bytes)
CREATE angular-prettier/package.json (791 bytes)
CREATE angular-prettier/tsconfig.json (908 bytes)
CREATE angular-prettier/tsconfig.app.json (398 bytes)
CREATE angular-prettier/tsconfig.spec.json (409 bytes)
CREATE angular-prettier/.vscode/extensions.json (130 bytes)
CREATE angular-prettier/.vscode/launch.json (470 bytes)
CREATE angular-prettier/.vscode/tasks.json (978 bytes)
CREATE angular-prettier/src/main.ts (222 bytes)
CREATE angular-prettier/src/index.html (301 bytes)
CREATE angular-prettier/src/styles.css (80 bytes)
CREATE angular-prettier/src/app/app.css (0 bytes)
CREATE angular-prettier/src/app/app.spec.ts (690 bytes)
CREATE angular-prettier/src/app/app.ts (299 bytes)
CREATE angular-prettier/src/app/app.html (20144 bytes)
CREATE angular-prettier/src/app/app.config.ts (312 bytes)
CREATE angular-prettier/src/app/app.routes.ts (77 bytes)
CREATE angular-prettier/public/favicon.ico (15086 bytes)
- Installing packages (npm)...
√ Packages installed successfully.
    Successfully initialized git.
```

Then go inside the project with the command:
```bash
cd angular-prettier
```

And open the project with Visual Studio Code:
```bash
code .
```

If all has gone well so far, you should have the following architecture (without `node_modules`):
```text
angular-prettier/
├── .vscode/
│   ├── extensions.json
│   ├── launch.json
│   └── tasks.json
├── public/
│   └── favicon.ico
├── src/
│   ├── app/
│   │   ├── app.config.ts
│   │   ├── app.css
│   │   ├── app.html
│   │   ├── app.routes.ts
│   │   ├── app.spec.ts
│   │   └── app.ts
│   ├── index.html
│   ├── main.ts
│   └── styles.css
├── .editorconfig
├── .gitignore
├── .prettierrc
├── angular.json
├── package-lock.json
├── package.json
├── README.md
├── tsconfig.app.json
├── tsconfig.json
└── tsconfig.spec.json
```


## Prettier is already installed
Look closely at the first `CREATE` line above: there is a **.prettierrc** file! Recent versions of the Angular CLI add Prettier to every new project. With Angular CLI 22, `ng new` puts it in the **devDependencies** of the **package.json** file:
```json
"devDependencies": {
  "@angular/build": "^22.2.6",
  "@angular/cli": "^22.2.6",
  "@angular/compiler-cli": "^22.2.0",
  "jsdom": "^30.0.0",
  "prettier": "^3.8.1",
  "typescript": "~6.0.2",
  "vitest": "^5.0.0"
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

So this time, these really are the settings chosen by the Angular team. 😉

If your project was created with an older version of the CLI, you can still install Prettier yourself:
```bash
npm install prettier --save-dev
```

> **_Note:_**  The `--save-dev` option will install Prettier as devDependency as the application does not need Prettier to run.


## Configure Prettier
The **.prettierrc** file at the root of the project lets editors and other tools know that we are using Prettier with a specific configuration. Let's extend the one generated by the CLI with the rules of our team:
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

Here we have several options:
- `printWidth`: Specify the line length that the printer will wrap on.
- `tabWidth`: Specify the number of spaces per indentation-level.
- `useTabs`: Indent lines with tabs instead of spaces.
- `singleQuote`: Use single quotes instead of double quotes.
- `semi`: Print semicolons at the ends of statements.
- `quoteProps`: Respect the input use of quotes in object properties.
- `bracketSpacing`: Print spaces between brackets in object literals (`false` gives `{Component}` instead of `{ Component }`).
- `overrides`: Format the `*.html` files with the `angular` parser.

Be careful with the option names! The first version of this article used `tabs` and `semicolon`, which are not Prettier options. Prettier 3 tells you so, and goes on with its defaults:
```text
Checking formatting...
[warn] Ignored unknown option { tabs: false }.
[warn] Ignored unknown option { semicolon: true }.
[warn] src/app/app.ts
[warn] Code style issues found in the above file. Run Prettier with --write to fix.
```

### Why the `angular` parser?
Prettier only infers the `angular` parser for files named `*.component.html`. With its current file naming style guide, the Angular CLI names the files `app.html`, `app.ts`… (no more `.component` suffix) so without the override, a template is formatted as plain HTML and the control flow blocks (`@if`, `@for`…) are not indented. Here is a messy template:
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

And with the `angular` parser:
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

Much better! 🙂

> **_Note:_**  Since Prettier 3, the default value of `trailingComma` is `"all"`: Prettier adds a trailing comma wherever possible in multi-line code, function arguments included. That is why the code generated by the CLI ends its multi-line objects with a comma. You can set `"trailingComma": "es5"` or `"none"` if your team prefers.


## Ignore files
It is recommended to have a **.prettierignore** in a project. This way we can tell to Prettier which files should not be formatted.

Therefore, let's create a **.prettierignore** file at the root of the project:
```text
dist
.angular
coverage
package-lock.json
```

Here `dist` is the build output, `.angular` the cache of the Angular CLI and `coverage` the code coverage report.

> **_Note:_**  By default Prettier ignores files in version control systems directories (".git", ".sl", ".svn", ".hg" and ".jj") and node_modules. Since Prettier 3, it also ignores the files listed in the **.gitignore** file.


## Check files
To check which files will be formatted by Prettier, we can use the following command:
```bash
npx prettier --check .
```

> **_Note:_**  `npx` runs the Prettier installed in the project's `node_modules`, so everyone in the team uses the same version.

This command will check all files in the project (except the ignored ones). We can also specify which directory and extensions we want to check, for example:
```bash
npx prettier --check "src/app/**/*.{json,css,scss,less,md,ts,html}"
```

To save a bit of time, let's add a new command in the **scripts** section of the **package.json** file:
```json
"format-check": "prettier --check ."
```

> **_Note:_**  Inside an npm script, there is no need for `npx`: npm already finds the commands of `node_modules/.bin`.

This way, we can use:
```bash
npm run format-check
```

After running the command, Prettier will give us the result of the verification:
```text
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
To format files with Prettier we can use the following command:
```bash
npx prettier --write .
```

Similarly to the `--check` option, we can specify which directory and which extensions we want to format:
```bash
npx prettier --write "src/app/**/*.{json,css,scss,less,md,ts,html}"
```

Again, let's add a new command in the **scripts** section of the **package.json** file:
```json
"format": "prettier --write ."
```

Now, we can run the new command:
```bash
npm run format
```

```text
> angular-prettier@0.0.0 format
> prettier --write .

.prettierrc 22ms (unchanged)
.vscode/extensions.json 2ms (unchanged)
.vscode/launch.json 2ms (unchanged)
.vscode/tasks.json 3ms (unchanged)
angular.json 3ms (unchanged)
package.json 2ms (unchanged)
README.md 35ms (unchanged)
src/app/app.config.ts 35ms
src/app/app.css 9ms (unchanged)
src/app/app.html 112ms
src/app/app.routes.ts 2ms
src/app/app.spec.ts 13ms
src/app/app.ts 5ms
src/index.html 3ms (unchanged)
src/main.ts 3ms
src/styles.css 1ms (unchanged)
tsconfig.app.json 2ms (unchanged)
tsconfig.json 2ms (unchanged)
tsconfig.spec.json 2ms (unchanged)
```

Below is the result before:
```ts
import { Component, signal } from '@angular/core';
import { RouterOutlet } from '@angular/router';

@Component({
  imports: [RouterOutlet],
  selector: 'app-root',
  styleUrl: './app.css',
  templateUrl: './app.html',
})
export class App {
  protected readonly title = signal('angular-prettier');
}
```

And after:
```ts
import {Component, signal} from '@angular/core';
import {RouterOutlet} from '@angular/router';

@Component({
  imports: [RouterOutlet],
  selector: 'app-root',
  styleUrl: './app.css',
  templateUrl: './app.html',
})
export class App {
  protected readonly title = signal('angular-prettier');
}
```

As we can see above, now we have no space between the brackets of the imports. The template is formatted too: in **app.html**, the objects inside the `@for` block become `{title: 'CLI Docs', link: 'https://angular.dev/tools/cli'}`, which proves that the `angular` parser formats the expressions of the control flow as well.

> **_Note:_**  If you also use ESLint, add [eslint-config-prettier](https://github.com/prettier/eslint-config-prettier) to your ESLint configuration. It turns off the ESLint rules that are unnecessary or might conflict with Prettier, so the two tools never fight over formatting. We do exactly that in [Configure Husky with Angular](https://blouppy.com/blog/2023-05-14-configure-husky-with-angular/).


## Conclusion
In this article, we configured Prettier in an Angular project.

Prettier is a code formatter that allows us to format our code automatically according to a configuration file.
It is a good practice to have a consistent code style for a project and a team and Prettier can help us in this task. And now that the Angular CLI installs it for us, there is no excuse anymore! 😄

I hope this article has helped you to have a better understanding of Prettier and that you will use it in your projects.

If you want to go further, the next articles of this series add [ESLint](https://blouppy.com/blog/2023-04-03-configure-eslint-with-angular/) and [Husky](https://blouppy.com/blog/2023-05-14-configure-husky-with-angular/) to an Angular project.

Source code of the article: [Github source code](https://github.com/jboinembalome/angular-prettier)

*Thanks for reading! 🙂*
