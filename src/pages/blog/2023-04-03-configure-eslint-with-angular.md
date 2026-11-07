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
description: Quick steps to install ESLint in an Angular project.
tags:
  - Development
  - Angular
  - ESLint
---

> **Updated November 2026:** rewritten for Angular 22. The package is now simply `angular-eslint`, and `ng add` generates an ESLint flat config (`eslint.config.js`) instead of `.eslintrc.json`, so I explain that new file below. 🙂

[ESLint](https://eslint.org/) is a popular static code analyzer (linter) that helps us find and fix problems in JavaScript code if configured rules are violated.
In the past, Angular used by default another linter called [TSLint](https://palantir.github.io/tslint/) which was [deprecated](https://blog.palantir.com/tslint-in-2019-1a144c2317a9) in 2019. This is because the TSLint team wanted to focus their efforts on ESLint's support for TypeScript as the tool of choice for JavaScript linting.

As a result, Angular has decided to remove TSLint from **Angular v12**.

In this article, we will install **ESLint** in an **Angular 22** project.

## Prerequisites
Before to start you will need:
- [Node.js](https://nodejs.org/en/): Angular **requires an active LTS (Long Term Support) or maintenance LTS version** of **Node.js** (for Angular 22: `^22.22.3`, `^24.15.0` or `>=26.0.0`).
- [Angular CLI](https://angular.dev/tools/cli): We will use the **Angular CLI** to create an Angular project.
- [Visual Studio Code](https://code.visualstudio.com/): The editor to open the project. (You can choose your favourite editor or IDE as well 🙂)


## Create an Angular project
Let's create a new project with the **Angular CLI** by running the following command in a terminal:
```bash
ng new angular-eslint
```
After running the command, Angular CLI will ask you few questions to configure your new Angular project. Here are my answers (CSS, no SSR, no AI tools) and what the CLI did next:
```text
√ Which stylesheet system would you like to use? CSS             [ https://developer.mozilla.org/docs/Web/CSS ]
√ Do you want to enable Server-Side Rendering (SSR) and Static Site Generation (SSG/Prerendering)? No
√ Which AI tools should Angular integrate with? https://angular.dev/ai/develop-with-ai None
CREATE angular-eslint/.prettierrc (161 bytes)
CREATE angular-eslint/README.md (1466 bytes)
CREATE angular-eslint/.editorconfig (314 bytes)
CREATE angular-eslint/.gitignore (622 bytes)
CREATE angular-eslint/angular.json (1927 bytes)
CREATE angular-eslint/package.json (789 bytes)
CREATE angular-eslint/tsconfig.json (908 bytes)
CREATE angular-eslint/tsconfig.app.json (398 bytes)
CREATE angular-eslint/tsconfig.spec.json (409 bytes)
CREATE angular-eslint/.vscode/extensions.json (130 bytes)
CREATE angular-eslint/.vscode/launch.json (470 bytes)
CREATE angular-eslint/.vscode/tasks.json (978 bytes)
CREATE angular-eslint/src/main.ts (222 bytes)
CREATE angular-eslint/src/index.html (299 bytes)
CREATE angular-eslint/src/styles.css (80 bytes)
CREATE angular-eslint/src/app/app.css (0 bytes)
CREATE angular-eslint/src/app/app.spec.ts (688 bytes)
CREATE angular-eslint/src/app/app.ts (297 bytes)
CREATE angular-eslint/src/app/app.html (20144 bytes)
CREATE angular-eslint/src/app/app.config.ts (312 bytes)
CREATE angular-eslint/src/app/app.routes.ts (77 bytes)
CREATE angular-eslint/public/favicon.ico (15086 bytes)
- Installing packages (npm)...
√ Packages installed successfully.
    Successfully initialized git.
```

Then go inside the project with the command:
```bash
cd angular-eslint
```

And open the project with Visual Studio Code:
```bash
code .
```

If all has gone well so far, you should have the following architecture (without `node_modules`):
```text
angular-eslint/
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

As you can see, there is still no linter in a new Angular project (but there is a Prettier configuration, see [Configure Prettier with Angular](https://blouppy.com/blog/2023-01-29-configure-prettier-with-angular/)).


## Install ESLint
Now, we will install ESLint in our project.

To do this, use the Angular CLI to add **angular-eslint**:
```bash
ng add angular-eslint
```

> **_Note:_**  In the first version of this article, the command was `ng add @angular-eslint/schematics`. Today, the single `angular-eslint` package brings the builder, the schematics, the ESLint plugins and the template parser together.

The CLI asks us to confirm the installation of the package. In addition to installing all the dependencies, the `ng add` command will automatically detect our Angular project without a configured linter.
It will then go ahead and connect everything for us:
```text
❯ Determining Package Manager
› Using package manager: npm
✔ Determining Package Manager
❯ Searching for compatible package version
› Found compatible package version: 22.6.0.
✔ Searching for compatible package version
❯ Loading package information
✔ Loading package information
❯ Installing package
✔ Installing package
    angular-eslint v22 matches this workspace's Angular v22.
    
    All angular-eslint dependencies have been successfully installed 🎉
    
    Please see https://github.com/angular-eslint/angular-eslint for how to add ESLint configuration to your project.
    
    We detected that you have a single project in your workspace and no existing linter wired up, so we are configuring ESLint for you automatically.
    
    Please see https://github.com/angular-eslint/angular-eslint for more information.
    
CREATE eslint.config.js (1004 bytes)
UPDATE package.json (934 bytes)
UPDATE angular.json (2211 bytes)
- Installing packages (npm)...
√ Packages installed successfully.
```

Here is what changed in our project:
- **package.json**: a new `"lint": "ng lint"` script and four new devDependencies: `angular-eslint`, `eslint`, `@eslint/js`, `typescript-eslint` (`angular-eslint` 22 for our Angular 22 project).
- **angular.json**: a new `lint` target which uses the `@angular-eslint/builder:lint` builder on `src/**/*.ts` and `src/**/*.html`. That is what makes `ng lint` work.
- **eslint.config.js**: the ESLint configuration.


## The eslint.config.js file
Since ESLint 9, the default configuration format is the **flat config**: one JavaScript file, `eslint.config.js`, which exports an array of configuration objects. It replaces the `.eslintrc.json` file of the first version of this article. Here is the file generated by `ng add`:
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

Let's take a look at it:
- `// @ts-check` and `defineConfig(...)`: the editor type-checks the configuration, so a typo in an option is underlined.
- The first object applies to the **TypeScript files** (`files: ['**/*.ts']`):
  - `extends` stacks the recommended rules of ESLint (`@eslint/js`), of [typescript-eslint](https://typescript-eslint.io/) (`recommended` and `stylistic`) and of Angular (`tsRecommended`).
  - `processor: angular.processInlineTemplates` extracts the inline templates (`template: '...'` in a component) so they are linted like `.html` files.
  - `rules` sets the selector conventions: components are `app-something` elements and directives are `appSomething` attributes. The `app` prefix comes from the `prefix` of our project in **angular.json**.
- The second object applies to the **templates** (`files: ['**/*.html']`): the recommended template rules and the **accessibility** rules (an `<img>` without `alt`, a `click` without a keyboard event…).

To add or change a rule, add it to the `rules` of the right object, for example `'@typescript-eslint/no-explicit-any': 'off'`.


## Analyze files
To analyze files with ESLint, we can use the following command:
```bash
ng lint
```

After running the command, ESLint will give us the result of the analysis:
```text
Linting "angular-eslint"...

All files pass linting.
```

The "All files pass linting" message above tells us that no problems were found.

The templates are analyzed too. For example, if I add `<img src="favicon.ico" />` at the end of **app.html**, the accessibility rules catch it:
```text
Linting "angular-eslint"...

~/angular-eslint/src/app/app.html
  355:1  error  <img/> element must have a text alternative  @angular-eslint/template/alt-text

✖ 1 problem (1 error, 0 warnings)

Lint errors found in the listed files.
```


## Fix files
To fix files with ESLint we can use the following command:
```bash
ng lint --fix
```

Let's add a small function in the **app.ts** file that can be fixed by ESLint:
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
  protected readonly title = signal('angular-eslint');

  protected sayHello(): string {
    let hello = 'Hello';
    return `${hello}, ${this.title()}!`;
  }
}
```

Then let's run the `ng lint` command to analyze the previous code:
```text
Linting "angular-eslint"...

~/angular-eslint/src/app/app.ts
  14:9  error  'hello' is never reassigned. Use 'const' instead  prefer-const

✖ 1 problem (1 error, 0 warnings)
  1 error and 0 warnings potentially fixable with the `--fix` option.

Lint errors found in the listed files.
```

Here ESLint informs us that `hello` is never reassigned and that we can use `const` instead of `let`.

Now let's run the `ng lint --fix` command:
```text
Linting "angular-eslint"...

All files pass linting.
```

And the function becomes:
```ts
  protected sayHello(): string {
    const hello = 'Hello';
    return `${hello}, ${this.title()}!`;
  }
```

As we can see above, `let` has been replaced by `const`. 😉


## VS Code Extension
One of the great things about ESLint is that it can be easily integrated with many popular editors and IDEs, including Visual Studio Code (VS Code).

To integrate ESLint with VS Code, you can install the **ESLint extension** (`dbaeumer.vscode-eslint`) by following these steps:

- Open VS Code
- Go to the Extensions view by clicking on the Extensions icon in the left-hand toolbar or by using the shortcut Ctrl+Shift+X (Windows, Linux) or Cmd+Shift+X (macOS).
- Search for "ESLint" in the search bar.
- Click on the "Install" button next to the "ESLint" extension.

After installing the ESLint extension, it will automatically detect the `eslint.config.js` file in your project and start providing you with feedback and suggestions for improving your code.

To suggest the extension to everyone who opens the project, add it to the **.vscode/extensions.json** file generated by the CLI:
```json
{
  // For more information, visit: https://go.microsoft.com/fwlink/?linkid=827846
  "recommendations": ["angular.ng-template", "dbaeumer.vscode-eslint"]
}
```


## Conclusion
In this article, we learned how to install ESLint in an Angular project. We started by creating a new Angular project and installing ESLint using the `angular-eslint` package. We then took a look at the generated `eslint.config.js` file, ran `ng lint` to analyze our files and `ng lint --fix` to fix any issues found by ESLint.

By using ESLint, we can detect and fix potential problems in our codebase and ensure that our code follows best practices and conventions.

I hope this article has helped you to have a better understanding of ESLint and that you will use it in your projects.

If you want to run ESLint and Prettier automatically before each commit, take a look at [Configure Husky with Angular](https://blouppy.com/blog/2023-05-14-configure-husky-with-angular/).

Source code of the article: [Github source code](https://github.com/jboinembalome/angular-eslint)

*Thanks for reading! 🙂*
