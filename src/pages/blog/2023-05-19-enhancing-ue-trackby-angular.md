---
templateKey: 'blog-post'
title: 'Enhancing User Experience with TrackBy in Angular'
date: 2023-05-19T18:24:10.000Z
author: Jimmy Boinembalome
authorimage: /img/jimmy.jpg
category: Angular
categorycolor: bg-red-100 text-red-800
featuredpost: true
featuredimage: /img/enhancing-ue-trackby-angular.jpg
description: Tips to avoid excessive DOM re-rendering.
tags:
  - Development
  - Angular
---
  
Angular's `ngFor` directive is used for rendering lists of items in Angular applications. However, when dealing with large datasets or frequently updating lists, the performance can suffer, resulting in a poor user experience. One way to improve this is by leveraging the `trackBy` feature of `ngFor`. 

In this article, we will explore how to provide a good user experience using `trackBy`.


## Understanding ngFor and its challenges
The `ngFor` directive allows developers to iterate over a collection and generate dynamic content for each item. It is a commonly used directive when working with lists, tables, or any other iterable data structures. By default, `ngFor` tracks items with the [object identity](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Object/is), which can lead to performance issues when the list is modified frequently.

Consider a scenario where a list is updated by adding, removing, or modifying items. Without proper tracking, Angular will re-render the entire list every time there is a change, causing unnecessary DOM manipulation and potentially affecting the application's performance.

## The power of `trackBy`
The `trackBy` feature of `ngFor` provides a way to specify a function that determines how Angular identifies items in the list. By providing a unique identifier for each item, Angular can accurately track changes and optimize the rendering process. This results in significant performance improvements and a smoother user experience.

To take advantage of `trackBy`, follow these steps:


## Step 1: Update your template
In your template, add the `trackBy` function to the `ngFor` directive. The function should take two arguments: the index and the item being iterated over. It should return a unique identifier for the item.

```html
<mat-list role="list">
    <mat-list-item role="listitem" *ngFor="let user of users; trackBy: trackByFn">
        {{ user.name }}
    </mat-list-item>
</mat-list>
```


## Step 2: Implement the `trackBy` function
In your component class, define the `trackByFn` function. This function will be responsible for generating a unique identifier for each item. Ideally, the identifier should remain consistent even if the item's properties change.

```typescript
trackByFn(index: number, item: User): number {
    return item.id ?? index; // Replace `id` with a property that uniquely identifies each item
}
```

> **_Note:_** The `item.id` here is only an example. You should use a property that uniquely identifies each item in your specific scenario.


## Step 3: Update your list operations
When modifying the list, it is crucial to keep the `trackBy` function in mind. Ensure that you are updating the items in a way that maintains their unique identifiers. For example, if you are adding a new item, make sure it has a unique identifier before pushing it into the list.


## Benefits of using `trackBy`
By implementing `trackBy` correctly, you can achieve several benefits:

### 1. Improved performance
Angular leverages the unique identifiers provided by `trackBy` to identify added, removed, or modified items efficiently. As a result, it can update the DOM more optimally, reducing unnecessary rendering and improving the overall performance of your application.

### 2. Smoother animations
When items are added or removed from the list, Angular can apply animations more effectively with the help of `trackBy`. The smooth transitions create a better user experience, making your application feel more polished and professional.

### 3. Prevented unnecessary DOM manipulation
By tracking items accurately, Angular can determine precisely which parts of the DOM need to be updated. This avoids unnecessary manipulations, resulting in faster rendering and a more responsive application.


## Conclusion
Providing a good user experience is crucial for the success of any Angular application, especially when dealing with lists that undergo frequent updates. By leveraging the `trackBy` feature of `ngFor`, you can improve performance, reduce unnecessary rendering, and create a smoother user experience. 

Remember to define a unique identifier in your `trackBy` function, update your template, and modify your lists while preserving the unique identifiers. By following this best practice, you can unlock the full potential of `ngFor` and provide a better user experience in your Angular applications.

Source code of the article: [Github source code](https://github.com/jboinembalome/angular-trackby)

*Happy coding! 🙂*