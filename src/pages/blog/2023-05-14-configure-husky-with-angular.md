---
templateKey: 'blog-post'
title: 'Configure Husky with Angular'
date: 2023-05-14T18:24:10.000Z
updated: 2026-11-07T09:00:00.000Z
author: Jimmy Boinembalome
authorimage: /img/jimmy.jpg
category: Angular
topic: 'Tooling'
illustration: 3
categorycolor: bg-red-100 text-red-800
featuredpost: true
featuredimage: /img/configure-husky-with-angular.jpg
description: Quick steps to install Husky in an Angular project.
tags:
  - Development
  - Angular
  - Husky
  - Commitlint
  - Lint-staged
---

> **Updated November 2026:** rewritten for Angular 22 and Husky 9. `husky install` and `husky add` are gone, so the hooks are now plain files that we write ourselves; I also fixed the lint-staged configuration (its `.html` pattern never matched) and every output below comes from real commits. 🙂

[Husky](https://typicode.github.io/husky/) is a powerful tool that allows you to add [Git hooks](https://git-scm.com/book/en/v2/Customizing-Git-Git-Hooks) to your project. These hooks can be used to run scripts or commands before or after certain Git actions, such as committing changes or pushing commits to a remote repository. [Commitlint](https://commitlint.js.org/) and [lint-staged](https://github.com/lint-staged/lint-staged) are two popular tools that can be used in conjunction with Husky to enforce code quality and formatting standards in your Angular project.

In this article, we will install **Husky**, **Commitlint** and **Lint-staged** in an **Angular 22** project.

## Prerequisites
Before to start you will need:
- [Node.js](https://nodejs.org/en/): Angular **requires an active LTS (Long Term Support) or maintenance LTS version** of **Node.js** (for Angular 22: `^22.22.3`, `^24.15.0` or `>=26.0.0`; commitlint 21 needs Node.js 22.12 or later).
- [Angular CLI](https://angular.dev/tools/cli): We will use the **Angular CLI** to create an Angular project.
- [Git](https://git-scm.com/): Husky manages Git hooks, so the project must be a Git repository (`ng new` initializes one for us).
- [Visual Studio Code](https://code.visualstudio.com/): The editor to open the project. (You can choose your favourite editor or IDE as well 🙂)


## Create an Angular project
Let's create a new project with the Angular CLI by running the following command in a terminal:
```bash
ng new angular-husky
```
After running the command, Angular CLI will ask you few questions to configure your new Angular project. Here are my answers (CSS, no SSR, no AI tools) and what the CLI did next:
```text
√ Which stylesheet system would you like to use? CSS             [ https://developer.mozilla.org/docs/Web/CSS ]
√ Do you want to enable Server-Side Rendering (SSR) and Static Site Generation (SSG/Prerendering)? No
√ Which AI tools should Angular integrate with? https://angular.dev/ai/develop-with-ai None
CREATE angular-husky/.prettierrc (161 bytes)
CREATE angular-husky/README.md (1465 bytes)
CREATE angular-husky/.editorconfig (314 bytes)
CREATE angular-husky/.gitignore (622 bytes)
CREATE angular-husky/angular.json (1924 bytes)
CREATE angular-husky/package.json (788 bytes)
CREATE angular-husky/tsconfig.json (908 bytes)
CREATE angular-husky/tsconfig.app.json (398 bytes)
CREATE angular-husky/tsconfig.spec.json (409 bytes)
CREATE angular-husky/.vscode/extensions.json (130 bytes)
CREATE angular-husky/.vscode/launch.json (470 bytes)
CREATE angular-husky/.vscode/tasks.json (978 bytes)
CREATE angular-husky/src/main.ts (222 bytes)
CREATE angular-husky/src/index.html (298 bytes)
CREATE angular-husky/src/styles.css (80 bytes)
CREATE angular-husky/src/app/app.css (0 bytes)
CREATE angular-husky/src/app/app.spec.ts (687 bytes)
CREATE angular-husky/src/app/app.ts (296 bytes)
CREATE angular-husky/src/app/app.html (20144 bytes)
CREATE angular-husky/src/app/app.config.ts (312 bytes)
CREATE angular-husky/src/app/app.routes.ts (77 bytes)
CREATE angular-husky/public/favicon.ico (15086 bytes)
- Installing packages (npm)...
√ Packages installed successfully.
    Successfully initialized git.
```

Then go inside the project with the command:
```bash
cd angular-husky
```

And open the project with Visual Studio Code:
```bash
code .
```

If all has gone well so far, you should have the following architecture (without `node_modules`):
```text
angular-husky/
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

> **_Note:_**  Prettier is already installed by the Angular CLI, and we will also need ESLint later. In the sample project, I added ESLint with `ng add angular-eslint` and used the Prettier configuration of the previous articles:
>
> - [Configure ESLint with Angular](https://blouppy.com/blog/2023-04-03-configure-eslint-with-angular/)
> - [Configure Prettier with Angular](https://blouppy.com/blog/2023-01-29-configure-prettier-with-angular/)


## Install Husky
Now, we will install Husky in our project.

To do this, run the following command:
```bash
npm install husky --save-dev
```

> **_Note:_**  The `--save-dev` option will install Husky as devDependency as the application does not need Husky to run.

Then let's initialize Husky with the following command:
```bash
npx husky init
```

This command does everything that `husky install` and `npm pkg set scripts.prepare` did in the first version of this article. It:
- adds a `prepare` script to the **package.json** file, so the Git hooks are enabled automatically after every `npm install` (or `npm ci`):
```json
"scripts": {
  "prepare": "husky"
}
```
- creates a **.husky/pre-commit** hook which runs `npm test` (we will replace it in a moment);
- points Git to the hooks of the project (`git config core.hooksPath` now returns `.husky/_`).

> **_Note:_**  With Husky 9, a hook is a plain shell file in the **.husky** directory, named after the Git hook. There is no `husky add` command anymore, and no more `#!/usr/bin/env sh` and `. "$(dirname -- "$0")/_/husky.sh"` lines at the top of the files.


## Install commitlint
Next, we will install commitlint, which is a tool that enforces commit message conventions. To install commitlint, run the following command:
```bash
npm install @commitlint/cli @commitlint/config-conventional --save-dev
```


## Configure commitlint
After installing commitlint, we will need to configure it to enforce commit message conventions in our project.

The commitlint documentation now writes the configuration as an ES module (`export default`). But the **package.json** of an Angular project has no `"type": "module"`, so a **commitlint.config.js** containing `export default` works but Node.js prints a warning on every commit:
```text
(node:12956) [MODULE_TYPELESS_PACKAGE_JSON] Warning: Module type of file://~/angular-husky/commitlint.config.js is not specified and it doesn't parse as CommonJS.
Reparsing as ES module because module syntax was detected. This incurs a performance overhead.
To eliminate this warning, add "type": "module" to ~/angular-husky/package.json.
(Use `node --trace-warnings ...` to show where the warning was created)
```

And adding `"type": "module"` would break the **eslint.config.js** generated by `angular-eslint`, which uses `require`. So let's use the `.mjs` extension, which tells Node.js that the file is an ES module. Create a **commitlint.config.mjs** file at the root of the project:
```js
export default {
  extends: ['@commitlint/config-conventional'],
};
```

Now let's add our Git hook. Create a **.husky/commit-msg** file containing a single line:
```bash
npx --no -- commitlint --edit "$1"
```

This hook runs commitlint to validate the commit message (Git passes the path of the message file as `$1`) according to the configured rules.

Let's test to make sure it works. We can give a message to commitlint directly, without committing anything:
```text
$ echo "add a greeting" | npx commitlint
⧗   --- input ---
add a greeting
✖   subject may not be empty [subject-empty]
✖   type may not be empty [type-empty]

✖   found 2 problems, 0 warnings
ⓘ   Get help: https://github.com/conventional-changelog/commitlint/#what-is-commitlint

```

As we can see, the message does not respect the [convention](https://www.conventionalcommits.org/), so commitlint exits with an error and the commit-msg hook will reject the commit (we will see it for real below). A message like `feat: add a greeting` passes without a word.


## Install lint-staged
Now that we have installed and configured Husky and commitlint, we will install lint-staged, which is a tool that allows us to run tools like [ESLint](https://eslint.org/) and [Prettier](https://prettier.io/) on staged files.

To install lint-staged, run the following command:
```bash
npm install lint-staged --save-dev
```

> **_Note:_**  If you don't know how to install ESLint and Prettier in an Angular project, you can take a look to these articles
>
> - [Configure ESLint with Angular](https://blouppy.com/blog/2023-04-03-configure-eslint-with-angular/)
> - [Configure Prettier with Angular](https://blouppy.com/blog/2023-01-29-configure-prettier-with-angular/)

Since ESLint and Prettier will both touch our files, let's also install [eslint-config-prettier](https://github.com/prettier/eslint-config-prettier), which turns off the ESLint rules that are unnecessary or might conflict with Prettier:
```bash
npm install eslint-config-prettier --save-dev
```

And add it **last** in **eslint.config.js**, so it overrides the configurations before it:
```js
const angular = require('angular-eslint');
const eslintConfigPrettier = require('eslint-config-prettier/flat');

module.exports = defineConfig([
  // ... the two objects generated by angular-eslint
  eslintConfigPrettier,
]);
```


## Configure lint-staged
After installing lint-staged, we will configure it to run the linters on staged files. Therefore, create a new file named **.lintstagedrc.json** in the root of the project and add the following code:
```json
{
  "*.{ts,html}": ["eslint --fix", "prettier --write"],
  "*.{json,css,scss,less,md}": ["prettier --write"]
}
```

Two things changed since the first version of this article:
- The pattern was `"*.{ts, html}"`. With the space, the second extension is `" html"`, so the **.html** files never matched and were never linted. 😅
- The two patterns no longer overlap. lint-staged runs the patterns at the same time, so with `.ts` files in both, `eslint --fix` and `prettier --write` could edit the same file simultaneously. Inside an array, the commands run one after the other: ESLint first, then Prettier.

> **_Note:_**  The file was named **.lintstagedrc.js** while it contained JSON. A `.js` file must be JavaScript, so a JSON configuration goes in **.lintstagedrc.json** (or in a `"lint-staged"` key of the **package.json** file).

Finally, we can configure Husky to run lint-staged. Replace the content of the **.husky/pre-commit** file created by `husky init` with:
```bash
npx lint-staged
```

Now, if we commit one or more files, **Husky will first run the pre-commit hook**, which will **execute lint-staged** to format files and check for linting errors. If there are any issues found, the commit will be **aborted**.

Assuming lint-staged passes, **Husky will then run the commit-msg hook**. **The commit message will then be validated by commitlint**. If the commit message fails validation, the commit will be **aborted**.

If both hooks pass, **the commit will be created and the changes will be added to the Git repository**. 🙂


## Let's try it
Let's add a small function in the **app.ts** file, written a bit carelessly (`let`, double quotes, no semicolons):
```ts
  protected sayHello(): string {
    let hello = "Hello"
    return `${hello}, ${this.title()}!`
  }
```

Then let's stage it and commit it, first with a message that does not respect the convention:
```text
$ git add src/app/app.ts
$ git commit -m "add a greeting"
⋯ Backing up original state…
✔ Done backing up original state (c32cf2b)!
⋯ Running tasks for staged files…
    *.{ts,html} — 1 file
      ⋯ eslint --fix
      ⋯ prettier --write

✔ eslint --fix
✔ prettier --write

✔ Done running tasks for staged files!
⋯ Staging changes from tasks…
✔ Done staging changes from tasks!
⋯ Cleaning up temporary files…
✔ Done cleaning up temporary files!
⧗   --- input ---
add a greeting
✖   subject may not be empty [subject-empty]
✖   type may not be empty [type-empty]

✖   found 2 problems, 0 warnings
ⓘ   Get help: https://github.com/conventional-changelog/commitlint/#what-is-commitlint

husky - commit-msg script failed (code 1)
```

lint-staged ran (the pre-commit hook passed), then commitlint rejected the message: no commit was created. Let's stage the same careless function again and use a valid message:
```text
$ git add src/app/app.ts
$ git commit -m "feat: add a greeting"
⋯ Backing up original state…
✔ Done backing up original state (2aaf23c)!
⋯ Running tasks for staged files…
    *.{ts,html} — 1 file
      ⋯ eslint --fix
      ⋯ prettier --write

✔ eslint --fix
✔ prettier --write

✔ Done running tasks for staged files!
⋯ Staging changes from tasks…
✔ Done staging changes from tasks!
⋯ Cleaning up temporary files…
✔ Done cleaning up temporary files!
[chore/update-2026 94fae7f] feat: add a greeting
 1 file changed, 5 insertions(+)
```

And here is what was committed:
```ts
  protected sayHello(): string {
    const hello = 'Hello';
    return `${hello}, ${this.title()}!`;
  }
```

ESLint replaced `let` by `const`, then Prettier added the single quotes and the semicolons. 😉

What if ESLint finds a problem that it cannot fix? Let's add `protected data: any = {};` to the component and commit again:
```text
$ git commit -m "feat: keep some data"
⋯ Backing up original state…
✔ Done backing up original state (2326025)!
⋯ Running tasks for staged files…
    *.{ts,html} — 1 file
      ⋯ eslint --fix
      ⋯ prettier --write

✖ eslint --fix
↓ prettier --write

✖ Failed to run tasks for staged files!
↓ Skipped staging changes from tasks…
⋯ Reverting to original state because of errors…
✔ Done reverting to original state!
⋯ Cleaning up temporary files…
✔ Done cleaning up temporary files!

✖ eslint --fix:

~/angular-husky/src/app/app.ts
  12:19  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any

✖ 1 problem (1 error, 0 warnings)
husky - pre-commit script failed (code 1)
```

The commit is aborted and our files are back to their original state. We just have to give `data` a real type. 🙂


## Conclusion
In this article, we have learned how to set up Husky with commitlint and lint-staged for an Angular project. By using Husky, we can run the pre-commit and commit-msg hooks to enforce our code quality and commit message conventions in our project.

In addition, Husky can be used for a variety of use cases beyond those mentioned here. For example, it is also possible to use Husky to run tests before committing your changes or to run a script in a pre-push hook: just create a **.husky/pre-push** file with the command to run.

I hope you found this article useful! 👍

Source code of the article: [Github source code](https://github.com/jboinembalome/angular-husky)

*Thanks for reading! 🙂*
