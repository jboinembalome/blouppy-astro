---
templateKey: 'blog-post'
title: 'Enhancing User Experience with track in Angular'
date: 2023-05-19T18:24:10.000Z
updated: 2026-11-07T09:00:00.000Z
author: Jimmy Boinembalome
authorimage: /img/jimmy.jpg
category: Angular
topic: 'Front end'
illustration: 2
categorycolor: bg-red-100 text-red-800
featuredpost: true
featuredimage: /img/enhancing-ue-trackby-angular.jpg
description: Tips to avoid excessive DOM re-rendering.
tags:
  - Development
  - Angular
---

> **Updated November 2026:** rewritten for Angular 22: `*ngFor` and its `trackBy` function became the built-in `@for` block, where `track` is mandatory. I also measured the DOM work for real, and corrected what I wrote about "re-rendering the entire list".

Angular's `@for` block is used for rendering lists of items in Angular applications. However, when dealing with large datasets or frequently updating lists, the performance can suffer, resulting in a poor user experience. One way to improve this is to give `@for` a good `track` expression.

In this article, we will explore how to provide a good user experience using `track`.


## Understanding @for and its challenges
The `@for` block allows developers to iterate over a collection and generate dynamic content for each item. It is a commonly used block when working with lists, tables, or any other iterable data structures. It replaced the `*ngFor` directive (and its `trackBy` function) in Angular 17, and it has one important difference: **the `track` expression is mandatory**.

```html
@for (user of users(); track user.id) {
  <li>{{ user.name }}</li>
} @empty {
  <li>No users</li>
}
```

The `track` expression gives each item a **key**. When the list changes, Angular compares the old keys with the new ones:
- an item whose key still exists keeps its DOM nodes (they are moved if needed, and only the bindings that changed are written);
- an item with a new key gets new DOM nodes;
- an item whose key disappeared has its DOM nodes destroyed.

Inside the block you also get `$index` (and `$first`, `$last`, `$even`, `$odd`, `$count`), and the optional `@empty` block is displayed when the collection is empty.

So the real question is: **which key do you give Angular?** 🤔

Consider a scenario where a list is refreshed from an API. The data is the same, but every user is a **new object**. If the key is the object itself (`track user`, which is also what `*ngFor` did by default with [object identity](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Object/is)), every key is new: Angular destroys every row and creates them again, even though nothing visible changed.

In the first version of this article, I wrote that without proper tracking Angular "re-renders the entire list every time there is a change". That was overstated: with identity tracking, a row is only recreated when **its object reference** changes. If you add one object to the list and keep the others, only one row is created. The full re-rendering happens when the references change, which is exactly what an HTTP refresh does.

## The power of `track`
By providing a unique and **stable** identifier for each item, Angular can accurately track changes and optimize the rendering process. This results in significant performance improvements and a smoother user experience.

I did not want to just claim it, so I measured it. The [sample repository](https://github.com/jboinembalome/angular-trackby) renders the same six users three times, with three different `track` expressions:

![The same users rendered with track user.id, track $index and track user](/img/enhancing-ue-trackby-angular-demo-lists.png)

A small Playwright script (`npm run dom-changes`) puts a `MutationObserver` on each list, clicks a button and counts the `<li>` elements created and removed, and the text nodes written. **Refresh** reloads the users as new objects with the same ids. **Add a user at the top** prepends one user and keeps the other objects:

```text
Refresh
┌───────────────┬─────────┬─────────┬────────────┐
│ (index)       │ created │ removed │ textWrites │
├───────────────┼─────────┼─────────┼────────────┤
│ track user.id │ 0       │ 0       │ 0          │
│ track $index  │ 0       │ 0       │ 0          │
│ track user    │ 6       │ 6       │ 6          │
└───────────────┴─────────┴─────────┴────────────┘

Add a user at the top
┌───────────────┬─────────┬─────────┬────────────┐
│ (index)       │ created │ removed │ textWrites │
├───────────────┼─────────┼─────────┼────────────┤
│ track user.id │ 1       │ 0       │ 1          │
│ track $index  │ 1       │ 0       │ 7          │
│ track user    │ 1       │ 0       │ 1          │
└───────────────┴─────────┴─────────┴────────────┘
```

Here is what happens:
- **`track user.id`**: on refresh, every id still exists, so Angular keeps the six rows and only hands them the new objects. `{{ user.name }}` is checked again, the value is the same, so nothing is written to the DOM: **zero** mutations. When a user is added at the top, one row is created and inserted at the top.
- **`track user`** (identity): on refresh, all six keys are new, so the six rows are destroyed and six new rows are created. In development mode, Angular even warns you about it in the console: `NG0956: The configured tracking expression (track by identity) caused re-creation of the entire collection of size 6.`
- **`track $index`**: it looks perfect on refresh, but when a user is added at the top, the new row is created **at the end** (index 6 is the new key), and the text of the six existing rows is rewritten so that everyone shifts down one row: 7 writes instead of 1. And everything a row holds (focus, the value typed in an input, the state of a child component, a running animation) stays at its **position** instead of following its user. 😬

`$index` is fine for a static list that never changes order. For anything else, use a real identifier.

To take advantage of `track`, follow these steps:


## Step 1: Update your template
In your template, use the `@for` block with a `track` expression that returns a unique identifier for each item. Here is the users component of the sample, with a signal holding the list:

```html
<ul>
  @for (user of users(); track user.id) {
    <li>{{ user.name }}</li>
  } @empty {
    <li class="empty">No users</li>
  }
</ul>
```

> **_Note:_** The `user.id` here is only an example. You should use a property that uniquely identifies each item in your specific scenario.

There is no `trackByFn` method to write anymore: the expression is written directly in the template.


## Step 2: Do not mix the id and the index
In the first version of this article, my `trackBy` function returned `item.id ?? index`. Please don't do this! 🙈

```html
<!-- ❌ Anti-pattern -->
@for (user of users(); track user.id ?? $index) {
  <li>{{ user.name }}</li>
}
```

It mixes two different kinds of keys in the same list:
- an item without an id is keyed by its **position**, so its key changes as soon as an item is added or removed before it, and Angular recreates its row (and moves its state to another item);
- an index can collide with an id: the item at index 0 without an id and the user whose id is `0` get the same key. I tried it: as soon as the list is updated, Angular warns `NG0955: The provided track expression resulted in duplicated keys for a given collection. [...] key "0" at index "0" and "1".`;
- and if `id` is not optional in your type, the fallback is dead code that hides the real problem.

If some items have no id yet (an item created on the client and not saved yet, for example), give them one before you put them in the list, such as a `crypto.randomUUID()`, and keep it once the server answers.


## Step 3: Update your list operations
When modifying the list, it is crucial to keep the `track` expression in mind. Ensure that you are updating the items in a way that maintains their unique identifiers. For example, if you are adding a new item, make sure it has a unique identifier before adding it to the list.

With a signal, you create a new array and Angular does the rest:

```typescript
import { Component, inject, signal } from '@angular/core';
import { User } from '../../models/user';
import { UsersService } from '../../services/users-service';

@Component({
  selector: 'app-users',
  styleUrl: './users.scss',
  templateUrl: './users.html',
})
export class Users {
  private readonly usersService = inject(UsersService);
  private nextId = 7;

  protected readonly users = signal<User[]>(this.usersService.getUsers());

  /**
   * Reloads the same users as new objects, like a refresh from an API.
   */
  refresh(): void {
    this.users.set(this.usersService.getUsers());
  }

  /**
   * Adds a new user at the top of the list. The other users keep their objects.
   */
  addFirst(): void {
    this.users.update((users) => [{ id: this.nextId++, name: 'Rosa Quill' }, ...users]);
  }

  clear(): void {
    this.users.set([]);
  }
}
```

Thanks to `track user.id`, `refresh()` can replace every object without any DOM work, and `addFirst()` creates exactly one row.


## Benefits of using `track`
By choosing your `track` expression correctly, you can achieve several benefits:

### 1. Improved performance
Angular uses the keys given by `track` to identify added, removed, or moved items efficiently. As we measured above, a refresh that returns new objects costs zero DOM operations with `track user.id`, instead of destroying and recreating every row. With rows containing components, images or directives, the difference is much bigger than six `<li>`.

### 2. Smoother animations
When items are added or removed from the list, Angular can apply animations (`animate.enter` and `animate.leave`) to the right rows only, because it knows which rows really are new. The smooth transitions create a better user experience, making your application feel more polished and professional.

### 3. Prevented unnecessary DOM manipulation
By tracking items accurately, Angular can determine precisely which parts of the DOM need to be updated. This avoids unnecessary manipulations, keeps the focus and the state of each row where the user expects them, and results in faster rendering and a more responsive application.


## Conclusion
Providing a good user experience is crucial for the success of any Angular application, especially when dealing with lists that undergo frequent updates. By giving `@for` a stable `track` expression, you can improve performance, reduce unnecessary rendering, and create a smoother user experience.

Remember to track by a unique and stable identifier, not by the object itself and not by `$index` when the list can change, never mix an id and an index, and modify your lists while preserving the unique identifiers. By following this best practice, you can unlock the full potential of `@for` and provide a better user experience in your Angular applications.

Source code of the article: [Github source code](https://github.com/jboinembalome/angular-trackby)

*Happy coding! 🙂*
