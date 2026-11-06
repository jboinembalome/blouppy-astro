---
templateKey: 'blog-post'
title: 'Configure ESLint with Angular'
date: 2023-04-03T18:24:10.000Z
author: Jimmy Boinembalome
authorimage: /img/jimmy.jpg
category: Angular
topic: 'Tooling'
illustration: 2
categorycolor: bg-red-100 text-red-800
featuredpost: true
featuredimage: /img/configure-eslint-with-angular.jpg
description: Quick steps to install EsLint in an Angular project.
tags:
  - Development
  - Angular
  - ESLint
---


[ESLint](https://eslint.org/) is a popular static code analyzer (linter) that helps us find and fix problems in JavaScript code if configured rules are violated.
In the past, Angular used by default another linter called [TSLint](https://palantir.github.io/tslint/) which was [deprecated](https://blog.palantir.com/tslint-in-2019-1a144c2317a9) in 2019. This is because the TSLint team wanted to focus their efforts on ESLint's support for TypeScript as the tool of choice for JavaScript linting.

As a result, Angular has decided to remove TSLint from **Angular v12**.

In this article, we will install **ESLint** in an **Angular v15** project.

## Prerequisites
Before to start you will need:
- [Node.js](https://nodejs.org/en/): Angular **requires an active LTS (Long Term Support) or maintenance LTS version** of **Node.js**.
- [Angular CLI](https://angular.io/cli): We will use the **Angular CLI** to create an Angular project.
- [Visual Studio Code](https://code.visualstudio.com/): The editor to add a new component inside the project. (You can choose your favourite editor or IDE as well 🙂)


## Create an Angular project
Let's create a new project with the **Angular CLI** by running the following command in a terminal:
```powershell
ng new angular-eslint
``` 
After running the command, Angular CLI will ask you few questions to configure your new Angular project:
![Create new Angular project](/img/angular-eslint-create-new-project.png)

Then go inside the project with the command:
```powershell
cd .\angular-eslint\
```

And open the project with Visual Studio Code:
```powershell
code .
``` 

If all has gone well so far, you should have the following architecture:
![Project architecture](/img/angular-eslint-project-architecture.png)


## Install ESLint
Now, we will install ESLint in our project.

To do this, use the Angular CLI to add **@angular-eslint/schematics**:
```powershell
ng add @angular-eslint/schematics
```

In addition to installing all the dependencies, the `ng add` command will automatically detect our Angular project without a configured linter. 
It will then go ahead and connect everything for us:
![Install @angular-eslint/schematics](/img/angular-eslint-install-eslint-schematics.png)


## Analize files
To analize files with ESLint, we can use the following command:
```powershell
ng lint
``` 

After running the command, ESLint will give us the result of the analize:
![Analize file with ESLint](/img/angular-eslint-ng-lint.png)

The "All files pass linting" message above tells us that no problems were found.


## Fix files
To fix files with ESLint we can use the following command:
```powershell
ng lint --fix
```

Let's add a small function in the **app.component.ts** file that can be fixed by ESLint:
![app.component.ts before fix](/img/angular-eslint-before-fix.png)

Then let's run the `ng lint` command to analyze the previous code:
![Analize error file with ESLint](/img/angular-eslint-ng-lint-with-error.png)

Here ESLint informs us that `hello` is never reassigned and that we can use `const` instead of `let`.

Now let's run the `ng lint --fix` command:
![app.component.ts after fix](/img/angular-eslint-after-fix.png)

As we can see above, `let` has been replaced by `const`. 😉


## VS Code Extension
One of the great things about ESLint is that it can be easily integrated with many popular editors and IDEs, including Visual Studio Code (VS Code).

To integrate ESLint with VS Code, you can install the **ESLint extension** by following these steps:

- Open VS Code
- Go to the Extensions view by clicking on the Extensions icon in the left-hand toolbar or by using the shortcut Ctrl+Shift+X (Windows, Linux) or Cmd+Shift+X (macOS).
- Search for "ESLint" in the search bar.
- Click on the "Install" button next to the "ESLint" extension.

After installing the ESLint extension, it will automatically detect ESLint configuration files in your project and start providing you with feedback and suggestions for improving your code.


## Conclusion
In this article, we learned how to install ESLint in an Angular project. We started by creating a new Angular project and installing ESLint using the `@angular-eslint/schematics` package. We then ran `ng lint` to analyze our files and `ng lint --fix` to fix any issues found by ESLint.

By using ESLint, we can detect and fix potential problems in our codebase and ensure that our code follows best practices and conventions.

I hope this article has helped you to have a better understanding of ESLint and that you will use it in your projects.

Source code of the article: [Github source code](https://github.com/jboinembalome/angular-eslint)

*Thanks for reading! 🙂*