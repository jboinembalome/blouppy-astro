---
templateKey: 'blog-post'
title: 'Configure Prettier with Angular'
date: 2023-01-29T18:24:10.000Z
author: Jimmy Boinembalome
authorimage: /img/jimmy.jpg
category: Angular
categorycolor: bg-red-100 text-red-800
featuredpost: true
featuredimage: /img/configure-prettier-with-angular.jpg
description: Quick steps to install Prettier in an Angular project.
tags:
  - Development
  - Angular
  - Prettier
---

When we work in a team project, it is possible to encounter inconsistent code. Indeed, one developer may use single quotes and tabs and another developer may use double quotes and spaces. Even though there is documentation in the project with a naming convention, it is possible to forget some rules during our development.

To help us apply code formatting rules and therefore promote consistent code, we can use [Prettier](https://prettier.io/).

In this article, we will install **Prettier** in an **Angular v15** project.

## Prerequisites
Before to start you will need:
- [Node.js](https://nodejs.org/en/): Angular **requires an active LTS (Long Term Support) or maintenance LTS version** of **Node.js**.
- [Angular CLI](https://angular.io/cli): We will use the **Angular CLI** to create an Angular project.
- [Visual Studio Code](https://code.visualstudio.com/): The editor to add a new component inside the project. (You can choose your favourite editor or IDE as well 🙂)


## Create an Angular project
Let's create a new project with the Angular CLI by running the following command in a terminal:
```powershell
ng new angular-prettier
``` 
After running the command, Angular CLI will ask you few questions to configure your new Angular project:
![Create new Angular project](/img/angular-prettier-create-new-project.png)

Then go inside the project with the command:
```powershell
cd .\angular-prettier\
```

And open the project with Visual Studio Code:
```powershell
code .
``` 

If all has gone well so far, you should have the following architecture:
![Project architecture](/img/angular-prettier-project-architecture.png)


## Install Prettier
Now, we will install Prettier in our project.

To do this, run the following command:
```powershell
npm install prettier --save-dev
```

> **_Note:_**  The `--save-dev` option will install Prettier as devDependency as the application does not need Prettier to run.


## Configure Prettier
Then create a **.prettierrc** file in the root of the project to let editors and other tools know that we are using Prettier with a specific configuration:
```json
{
  "printWidth": 100,
  "tabWidth": 2,
  "tabs": false,
  "singleQuote": true,
  "semicolon": true,
  "quoteProps": "preserve",
  "bracketSpacing": false
}
```

Here we have several options:
- `printWidth`: Specify the line length that the printer will wrap on.
- `tabWidth`: Specify the number of spaces per indentation-level.
- `tabs`: Indent lines with tabs instead of spaces.
- `singleQuote`: Use single quotes instead of double quotes.
- `semicolon`: Print semicolons at the ends of statements.
- `quoteProps`: Respect the input use of quotes in object properties.
- `bracketSpacing`: Print spaces between brackets in object literals.

The options used above are the options used by the Angular team. You can also change them according to your team.


## Ignore files
It is recommended to have a **.prettierignore** in a project. This way we can tell to Prettier which files should not be formatted. 

Therefore, let's create a **.prettierignore** file at the root of the project:
```text
build
e2e
package-lock.json
```

> **_Note:_**  By default Prettier ignores files in version control systems directories (".git", ".svn" and ".hg") and node_modules.


## Check files
To check which files will be formatted by prettier, we can use the following command:
```powershell
prettier --check .
``` 

This command will check all files in the project. We can also specify which directory and extensions we want to check, for example:
```powershell
prettier --check "src/app/**/*.{json,css,scss,less,md,ts,html}"
``` 

To save a bit of time, let's add a new command in the **scripts** section of the **package.json "** file:
```json
"format-check": "prettier --check \"src/app/**/*.{json,css,scss,less,md,ts,html}\""
``` 

This way, we can use:
```powershell
npm run format-check
``` 

After running the command, Prettier will give us the result of the verification:
![Check file with Prettier](/img/angular-prettier-check-files.png)


## Format files
To format files with Prettier we can use the following command:
```powershell
prettier --write .
``` 

Similary to the `--check` option, we can specify which directory and which extensions we want to format:
```powershell
prettier --write "src/app/**/*.{json,css,scss,less,md,ts,html}"
``` 

Again, let's add a new command in the **scripts** section of the **package.json "** file:
```json
"format": "prettier --write \"src/app/**/*.{json,css,scss,less,md,ts,html}\""
``` 

Now, we can run the new command:
```powershell
npm run format
``` 

Below is the result before:
![app.component.ts before format](/img/angular-prettier-app-compent-before-format.png)

And after:
![app.component.ts after format](/img/angular-prettier-app-compent-after-format.png)

As we can see above, now we have no space between the brackets on the first line and we have a semi-colon at the end of line 6.


## Conclusion
In this article, we installed Prettier in an Angular project. 

Prettier is a code formatter that allows us to format our code automatically according to a configuration file. 
It is a good practice to have a consistent code style for a project and a team and Prettier can help us in this task.

I hope this article has helped you to have a better understanding of Prettier and that you will use it in your projects.

Source code of the article: [Github source code](https://github.com/jboinembalome/angular-prettier)

*Thanks for reading! 🙂*