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
description: Install Angular Material 22 in a standalone Angular 22 project, understand the Material 3 theme that ng add generates and add your first Material button.
tags:
  - Development
  - Angular
  - Angular Material
---

> **Updated November 2026:** rewritten for Angular 22 and Angular Material 22: standalone components instead of `app.module.ts`, the new welcome page, the Material 3 theme `ng add` writes for you, and the new `matButton` API.

[Angular Material](https://material.angular.dev/) is the official library of UI components for Angular, based on the [Material Design 3](https://m3.material.io/) specification.

In this article, we install **Angular Material** in an **Angular 22** project and display our first Material component.

## Prerequisites
- [Node.js](https://nodejs.org/en/): Angular 22 requires an active or maintenance LTS version: `^22.22.3`, `^24.15.0` or `^26.0.0` (see [Version compatibility](https://angular.dev/reference/versions)).
- [Angular CLI](https://angular.dev/tools/cli): `npm install -g @angular/cli`.
- An editor. I use [Visual Studio Code](https://code.visualstudio.com/).

## Create an Angular project
Create a new project with the Angular CLI:
```bash
ng new angular-app-with-angular-material
```

The CLI asks a few questions. I chose Sass for the stylesheets, no server-side rendering and no AI tool configuration:
```text
√ Which stylesheet system would you like to use? Sass (SCSS)     [ https://sass-lang.com/documentation/syntax#scss                ]
√ Do you want to enable Server-Side Rendering (SSR) and Static Site Generation (SSG/Prerendering)? No
√ Which AI tools should Angular integrate with? https://angular.dev/ai/develop-with-ai None
```

> **_Note:_** The first time you run the CLI, it also asks whether to share pseudonymous usage data with the Angular team. The answer has no effect on the project.

Then open the project:
```bash
cd angular-app-with-angular-material
code .
```

You should have the following structure:
```text
angular-app-with-angular-material/
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
├── angular.json
├── package.json
└── ...
```

There is no `app.module.ts`: since Angular 19, components are [standalone](https://angular.dev/guide/components/importing) by default. The root component `App` lives in `app.ts`, and each component declares what it uses in its own `imports` array.

## Run the application
The Angular CLI includes a development server. Start it with:
```bash
ng serve --open
```

The `--open` option opens your browser on `http://localhost:4200/`, where you should see the welcome page:
![Welcome page of a new Angular 22 project](/img/install-angular-material-welcome-page-angular-22.png)

## Install Angular Material
Add Angular Material with [`ng add`](https://angular.dev/cli/add):
```bash
ng add @angular/material
```

This installs **Angular Material** and the [Component Dev Kit (CDK)](https://material.angular.dev/cdk/categories). It no longer installs `@angular/animations`: Angular Material 22 does not depend on it, so there is no `provideAnimations()` to add either.

The CLI asks you to confirm the installation, then to choose the colour palettes of your theme:
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

I kept **Azure/Blue**. The schematic then updates three files:
```text
UPDATE package.json (875 bytes)
✔ Packages installed successfully.
UPDATE src/styles.scss (1259 bytes)
UPDATE src/index.html (695 bytes)
```

`index.html` now loads the **Roboto** font and the [Material Symbols](https://fonts.google.com/icons) icon font. `styles.scss` defines a **Material 3** theme with the `mat.theme` mixin (the generated comments are removed here):
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

The mixin turns the palettes into [system variables](https://material.angular.dev/guide/system-variables) (`--mat-sys-primary`, `--mat-sys-surface`…). Every Material component reads them, and you can use them in your own styles too.

> **_Note:_** [`color-scheme`](https://developer.mozilla.org/docs/Web/CSS/color-scheme)`: light` forces the light theme. Set it to `light dark` and the theme follows the user's system settings, dark mode included, without a second theme.

## Display a component
Let's add a Material [button](https://material.angular.dev/components/button/overview) to the welcome page. With Material 3, a button picks its appearance with the `matButton` attribute:
```html
<button matButton>Text</button>
<button matButton="elevated">Elevated</button>
<button matButton="filled">Filled</button>
<button matButton="tonal">Tonal</button>
<button matButton="outlined">Outlined</button>
```
![Angular Material button appearances](/img/install-angular-material-button-appearances.png)

We use the filled button, which takes the primary colour of the theme.

> **_Note:_** The older `mat-raised-button`, `mat-flat-button` and `mat-stroked-button` attributes still work, but `matButton="elevated"`, `matButton="filled"` and `matButton="outlined"` are the current API. With a Material 3 theme, the colour comes from the theme, not from a `color="primary"` input.

Import the `MatButton` and `MatIcon` directives in the `imports` of the component that uses them, `src/app/app.ts`:
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

In `src/app/app.html`, add the button below the "Congratulations" paragraph:
```html
<button matButton="filled" class="new-component">
  <mat-icon>add</mat-icon>
  New component
</button>
```

Then give it some space in `src/app/app.scss`:
```scss
.new-component {
  margin-top: 1.5rem;
}
```

> **_Note:_** [`<mat-icon>`](https://material.angular.dev/components/icon/overview) uses the Material Symbols font that `ng add` added to `index.html`, so `add` renders as a "+" icon without any configuration. It also sets `aria-hidden="true"` by default, so a screen reader announces only the button's text.

If the server is no longer running, start it again with `ng serve --open`. The welcome page now shows the Material filled button:
![Welcome page with an Angular Material button](/img/install-angular-material-welcome-page-with-material-button.png)

The "New component" button has the Angular Material style, and the page background now comes from the theme too.

## Conclusion
In this article, we installed Angular Material in an Angular 22 project with a single `ng add` command, looked at the Material 3 theme it generates and displayed a Material button.

To go further, the [component documentation](https://material.angular.dev/components/categories) has many examples, and the [theming guide](https://material.angular.dev/guide/theming) explains everything `mat.theme` can do.

Source code of the article: [GitHub source code](https://github.com/jboinembalome/angular-app-with-angular-material)

## References
- [Angular Material: Getting started](https://material.angular.dev/guide/getting-started) — installing Angular Material with `ng add`.
- [Angular Material: Theming](https://material.angular.dev/guide/theming) — the `mat.theme` mixin, palettes, typography and density.
- [Angular Material: System variables](https://material.angular.dev/guide/system-variables) — the `--mat-sys-*` CSS variables.
- [Angular Material: Button](https://material.angular.dev/components/button/overview) — the `matButton` appearances.
- [Angular Material: Icon](https://material.angular.dev/components/icon/overview) — `<mat-icon>`, font icons and accessibility.
- [Angular: Version compatibility](https://angular.dev/reference/versions) — the Node.js versions each Angular version supports.
- [Angular: Importing and using components](https://angular.dev/guide/components/importing) — standalone components and their `imports`.
- [Angular CLI: ng add](https://angular.dev/cli/add) — what `ng add` does.
- [Material Design 3](https://m3.material.io/) — the design system Angular Material implements.
- [MDN: color-scheme](https://developer.mozilla.org/docs/Web/CSS/color-scheme) — light and dark colour schemes.
