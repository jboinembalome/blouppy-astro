---
templateKey: 'blog-post'
title: 'Install Angular Material in an Angular project'
date: 2023-01-01T18:24:10.000Z
author: Jimmy Boinembalome
authorimage: /img/jimmy.jpg
category: Angular
categorycolor: bg-red-100 text-red-800
featuredpost: true
featuredimage: /img/install-angular-material-in-an-angular-project.jpg
description: Quick steps to install Angular Material in an Angular project.
tags:
  - Development
  - Angular
  - Angular Material
---
  
**Angular Material** is an Angular UI Component framework based on the Material Design specification.

In this article, we will install **Angular Material** in an **Angular v15** project.


## Prerequisites
Before to start you will need:
- [Node.js](https://nodejs.org/en/): Angular **requires an active LTS (Long Term Support) or maintenance LTS version** of **Node.js**.
- [Angular CLI](https://angular.io/cli): We will use the **Angular CLI** to create an Angular project.
- [Visual Studio Code](https://code.visualstudio.com/): The editor to add a new component inside the project. (You can choose your favourite editor or IDE as well 🙂)


## Create an Angular project
Let's create a new project with the Angular CLI by running the following command in a terminal:
```powershell
ng new angular-app-with-angular-material
``` 
After running the command, Angular CLI will ask you few questions to configure your new Angular project:
![Create new Angular project](/img/install-angular-material-create-new-project.png)

Then go inside the project with the command:
```powershell
cd .\angular-app-with-angular-material\
```

And open the project with Visual Studio Code:
```powershell
code .
``` 

If all has gone well so far, you should have the following architecture:
![Project architecture](/img/install-angular-material-project-architecture.png)

## Run the application 
The Angular CLI includes a server, for us to build and serve our app locally.
To launch the server, we can use the following command:
```powershell
ng serve --open
``` 

> **_Note:_**  The `--open` option will automatically opens your browser.

After running the command, you should see a similar page:
![Home page without Angular Material](/img/install-angular-material-homepage-without-angular-material.png)


## Install Angular Material
Now, we will install Angular Material.

To do this, run the following command:
```powershell
ng add @angular/material
```

> **_Note:_**  The `ng add` command will install **Angular Material**, the [CDK](https://material.angular.io/cdk/categories) (Component Dev Kit) and [Angular Animations](https://angular.io/guide/animations) to animate the **Angular Material** components.


After running the command, Angular CLI will ask you a few questions to configure the theme colours, the typography and the animations of the components:
![Add Angular Material](/img/install-angular-material-add-angular-material.png)

## Display a component
Let's replace a button in the home page by an Angular Material button. 

If we go to the official Angular Material [website](https://material.angular.io/), the Angular team has provided us a list of [buttons](https://material.angular.io/components/button/overview) that we can use:
![Angular Material buttons](/img/install-angular-material-button-list.png)

Here we will use the Raised Button with the primary colour of the theme.

To do this, we need to import the `MatButtonModule` and `MatIconModule` that we want to display to the `app.module.ts` file:
```typescript
import {MatButtonModule} from '@angular/material/button';
import {MatIconModule} from '@angular/material/icon';

@NgModule ({
  imports: [
    MatButtonModule,
    MatIconModule
  ]
})
export class AppModule {}
```

Next, we will replace the "New component" button below:
```html
<button class="card card-small" (click)="selection.value = 'component'" tabindex="0">
      <svg class="material-icons" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/></svg>
      <span>New Component</span>
</button>
```

by:
```html
<button mat-raised-button color="primary" (click)="selection.value = 'component'" tabindex="0">
    <mat-icon>add</mat-icon>
    <span>New Component</span>
</button>
```

and finally we will launch the server again with the following command:
```powershell
ng serve --open
```

After this you should see the Material Raised button on the home page:
![Home page with Angular Material](/img/install-angular-material-homepage-with-angular-material.png)

As we can see above, the "New Component" button now has the **Angular Material** style!😍

## Conclusion
In this article we installed Angular Material in an Angular project. As we have seen, the installation of the framework can be done in a few minutes. 

If you want to use Angular Material, I recommend you to take a look at
the official documentation. The [documentation](https://material.angular.io/components/categories) is very detailed and has many examples.

I hope this article has helped you with the installation of Angular Material.

Source code of the article: [Github source code](https://github.com/jboinembalome/angular-app-with-angular-material)

*Thanks for reading! 🙂*