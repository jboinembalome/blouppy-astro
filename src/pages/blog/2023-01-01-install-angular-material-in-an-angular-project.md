---
templateKey: 'blog-post'
title: 'Install Angular Material in an Angular project'
date: 2023-01-01T18:24:10.000Z
updated: 2026-11-07T09:00:00.000Z
author: Jimmy Boinembalome
authorimage: /img/jimmy.jpg
category: Angular
topic: 'Front end'
illustration: 1
categorycolor: bg-red-100 text-red-800
featuredpost: true
featuredimage: /img/install-angular-material-in-an-angular-project.jpg
description: Quick steps to install Angular Material in an Angular project.
tags:
  - Development
  - Angular
  - Angular Material
---

> **Updated November 2026:** rewritten for Angular 22 and Angular Material 22: standalone components instead of `app.module.ts`, the new welcome page, the Material 3 theme `ng add` writes for you, and the new `matButton` API.

**Angular Material** is an Angular UI Component framework based on the Material Design specification.

In this article, we will install **Angular Material** in an **Angular 22** project.


## Prerequisites
Before to start you will need:
- [Node.js](https://nodejs.org/en/): Angular **requires an active LTS (Long Term Support) or maintenance LTS version** of **Node.js** (for Angular 22: Node.js 22.22.3 or later, 24.15.0 or later, or 26+).
- [Angular CLI](https://angular.dev/tools/cli): We will use the **Angular CLI** to create an Angular project (`npm install -g @angular/cli`).
- [Visual Studio Code](https://code.visualstudio.com/): The editor to modify the project. (You can choose your favourite editor or IDE as well 🙂)


## Create an Angular project
Let's create a new project with the Angular CLI by running the following command in a terminal:
```powershell
ng new angular-app-with-angular-material
```
After running the command, Angular CLI will ask you few questions to configure your new Angular project. Here are my answers (Sass for the stylesheets, no server-side rendering, no AI tool configuration):
```text
√ Which stylesheet system would you like to use? Sass (SCSS)     [ https://sass-lang.com/documentation/syntax#scss                ]
√ Do you want to enable Server-Side Rendering (SSR) and Static Site Generation (SSG/Prerendering)? No
√ Which AI tools should Angular integrate with? https://angular.dev/ai/develop-with-ai None
```

> **_Note:_** The very first time you run the CLI, it also asks whether you want to share pseudonymous usage data with the Angular team. Answer as you like, it has no effect on the project.

Then go inside the project with the command:
```powershell
cd .\angular-app-with-angular-material\
```

And open the project with Visual Studio Code:
```powershell
code .
```

If all has gone well so far, you should have the following architecture:
```text
angular-app-with-angular-material/
├── .vscode/
├── node_modules/
├── public/
│   └── favicon.ico
├── src/
│   ├── app/
│   │   ├── app.config.ts
│   │   ├── app.html
│   │   ├── app.routes.ts
│   │   ├── app.scss
│   │   ├── app.spec.ts
│   │   └── app.ts
│   ├── index.html
│   ├── main.ts
│   └── styles.scss
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

There is no `app.module.ts` anymore: since Angular 19, components are **standalone** by default. The root component `App` lives in `app.ts`, and each component declares what it uses in its own `imports` array. 🙂

## Run the application
The Angular CLI includes a server, for us to build and serve our app locally.
To launch the server, we can use the following command:
```powershell
ng serve --open
```

> **_Note:_**  The `--open` option will automatically open your browser on `http://localhost:4200/`.

After running the command, you should see a similar page:
![Welcome page of a new Angular 22 project](/img/install-angular-material-welcome-page-angular-22.png)


## Install Angular Material
Now, we will install Angular Material.

To do this, run the following command:
```powershell
ng add @angular/material
```

> **_Note:_**  The `ng add` command will install **Angular Material** and the [CDK](https://material.angular.dev/cdk/categories) (Component Dev Kit). It no longer installs [Angular Animations](https://angular.dev/guide/animations): Angular Material 22 does not depend on `@angular/animations` anymore, so there is no `provideAnimations()` to add either.

After running the command, Angular CLI will ask you to confirm the installation, then to choose the colour palettes of your theme:
```text
The package @angular/material@^22.2.6 will be installed and executed.
Would you like to proceed? Yes
✔ Confirming installation
✔ Installing package
? Select a pair of starter prebuilt color palettes for your Angular Material theme
> Azure/Blue         [Preview: https://material.angular.dev?theme=azure-blue]
  Rose/Red           [Preview: https://material.angular.dev?theme=rose-red]
  Magenta/Violet     [Preview: https://material.angular.dev?theme=magenta-violet]
  Cyan/Orange        [Preview: https://material.angular.dev?theme=cyan-orange]
```

I kept **Azure/Blue**. Then the schematic updates three files:
```text
UPDATE package.json (875 bytes)
✔ Packages installed successfully.
UPDATE src/styles.scss (1259 bytes)
UPDATE src/index.html (695 bytes)
```

`index.html` now loads the **Roboto** font and the **Material Symbols** icon font, and `styles.scss` defines a **Material 3** theme with the `mat.theme` mixin:
```scss
@use '@angular/material' as mat;

html {
  height: 100%;
  @include mat.theme(
    (
      color: (
        primary: mat.$azure-palette,
        tertiary: mat.$blue-palette,
      ),
      typography: Roboto,
      density: 0,
    )
  );
}

body {
  color-scheme: light;
  background-color: var(--mat-sys-surface);
  color: var(--mat-sys-on-surface);
  font: var(--mat-sys-body-medium);
  margin: 0;
  height: 100%;
}
```

The mixin turns the palettes into CSS variables (`--mat-sys-primary`, `--mat-sys-surface`…) that every Material component reads, and that you can use in your own styles too.

> **_Note:_** `color-scheme: light` forces the light theme. Change it to `light dark` and the theme follows the user's system settings, dark mode included, without a second theme. 😎

## Display a component
Let's add an Angular Material button to the welcome page.

If we go to the official Angular Material [website](https://material.angular.dev/), the Angular team has provided us a list of [buttons](https://material.angular.dev/components/button/overview) that we can use. With Material 3, a button picks its style with the `matButton` attribute:
```html
<button matButton>Text</button>
<button matButton="elevated">Elevated</button>
<button matButton="filled">Filled</button>
<button matButton="tonal">Tonal</button>
<button matButton="outlined">Outlined</button>
```
![Angular Material button appearances](/img/install-angular-material-button-appearances.png)

Here we will use the filled button, which takes the primary colour of the theme.

> **_Note:_** The old `mat-raised-button`, `mat-flat-button` and `mat-stroked-button` attributes still work, but `matButton="elevated"`, `matButton="filled"` and `matButton="outlined"` are the current way to write them. And with a Material 3 theme, the colour comes from the theme rather than from a `color="primary"` input.

To do this, we need to import the `MatButton` and `MatIcon` directives into the `imports` of the component that uses them, `src/app/app.ts`:
```typescript
import { Component, signal } from '@angular/core';
import { MatButton } from '@angular/material/button';
import { MatIcon } from '@angular/material/icon';
import { RouterOutlet } from '@angular/router';

@Component({
  imports: [RouterOutlet, MatButton, MatIcon],
  selector: 'app-root',
  styleUrl: './app.scss',
  templateUrl: './app.html',
})
export class App {
  protected readonly title = signal('angular-app-with-angular-material');
}
```

Next, in `src/app/app.html`, we will add the button below the "Congratulations" paragraph:
```html
<h1>Hello, {{ title() }}</h1>
<p>Congratulations! Your app is running. 🎉</p>
<button matButton="filled" class="new-component">
  <mat-icon>add</mat-icon>
  New component
</button>
```

and give it a little space in `src/app/app.scss`:
```scss
.new-component {
  margin-top: 1.5rem;
}
```

> **_Note:_** `<mat-icon>` finds the **Material Symbols** font that `ng add` added to `index.html` by itself, so `add` is displayed as a "+" icon without any configuration.

Finally, if the server is not running anymore, launch it again with the following command:
```powershell
ng serve --open
```

After this you should see the Material filled button on the welcome page:
![Welcome page with an Angular Material button](/img/install-angular-material-welcome-page-with-material-button.png)

As we can see above, the "New component" button has the **Angular Material** style, and the page background now comes from the theme too!😍

## Conclusion
In this article we installed Angular Material in an Angular project. As we have seen, the installation of the framework can be done in a few minutes.

If you want to use Angular Material, I recommend you to take a look at
the official documentation. The [documentation](https://material.angular.dev/components/categories) is very detailed and has many examples, and the [theming guide](https://material.angular.dev/guide/theming) explains everything `mat.theme` can do.

I hope this article has helped you with the installation of Angular Material.

Source code of the article: [Github source code](https://github.com/jboinembalome/angular-app-with-angular-material)

*Thanks for reading! 🙂*
