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
description: Choose the right track expression for Angular's @for block, measured in the DOM, to avoid recreating list rows and losing their state.
tags:
  - Development
  - Angular
---

> **Updated November 2026:** rewritten for Angular 22: `*ngFor` and its `trackBy` function became the built-in `@for` block, where `track` is mandatory. I also measured the DOM work for real, and corrected what I wrote about "re-rendering the entire list".

Angular's [`@for` block](https://angular.dev/api/core/@for) renders lists. With large or frequently updated lists, a poor tracking strategy makes Angular destroy and recreate rows that did not change, which costs time and loses their state. The fix is a good `track` expression.

In this article, we measure what each `track` expression costs and see how to choose one.

## How `@for` tracks items
`@for` replaced the `*ngFor` directive and its `trackBy` function in Angular 17. One important difference: **the `track` expression is mandatory**.

```html
@for (user of users(); track user.id) {
  <li>{{ user.name }}</li>
} @empty {
  <li>No users</li>
}
```

The `track` expression gives each item a **key**. When the list changes, Angular compares the old keys with the new ones:
- an item whose key still exists keeps its DOM nodes (moved if needed; only the bindings that changed are written);
- an item with a new key gets new DOM nodes;
- an item whose key disappeared has its DOM nodes destroyed.

Inside the block, you also get `$index`, `$first`, `$last`, `$even`, `$odd` and `$count`. The optional `@empty` block is displayed when the collection is empty (see [Control flow](https://angular.dev/guide/templates/control-flow)).

So the real question is: **which key do you give Angular?**

Consider a list refreshed from an API. The data is the same, but every user is a **new object**. If the key is the object itself (`track user`, which is what `*ngFor` did by default, with [`Object.is`](https://developer.mozilla.org/docs/Web/JavaScript/Reference/Global_Objects/Object/is)), every key is new: Angular destroys every row and creates it again, although nothing visible changed.

In the first version of this article, I wrote that without proper tracking Angular "re-renders the entire list every time there is a change". That was overstated: with identity tracking, a row is recreated only when **its object reference** changes. The whole list is recreated when every reference changes, which is exactly what an HTTP refresh does.

## Measuring the difference
The [sample repository](https://github.com/jboinembalome/angular-trackby) renders the same six users three times, with three different `track` expressions:

![The same users rendered with track user.id, track $index and track user](/img/enhancing-ue-trackby-angular-demo-lists.png)

A small [Playwright](https://playwright.dev/) script (`npm run dom-changes`) puts a [`MutationObserver`](https://developer.mozilla.org/docs/Web/API/MutationObserver) on each list, clicks a button and counts the `<li>` elements created and removed, and the text nodes written. **Refresh** reloads the users as new objects with the same ids. **Add a user at the top** prepends one user and keeps the other objects:

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
- **`track user`** (identity): on refresh, all six keys are new, so the six rows are destroyed and recreated. In development mode, Angular warns about it in the console: `NG0956: The configured tracking expression (track by identity) caused re-creation of the entire collection of size 6.` (see [NG0956](https://angular.dev/errors/NG0956)).
- **`track $index`**: it looks perfect on refresh. But when a user is added at the top, the new row is created **at the end** (index 6 is the new key), and the text of the six existing rows is rewritten so that everyone shifts down one row: 7 writes instead of 1. Everything a row holds (focus, the value typed in an input, the state of a child component, a running animation) stays at its **position** instead of following its user.

`$index` is fine for a static list that never changes order. For anything else, use a real identifier.

## Step 1: Track by a unique identifier
In the template, give `@for` a `track` expression that returns a unique, stable identifier for each item. Here is the users component of the sample, with a signal holding the list:

```html
<ul>
  @for (user of users(); track user.id) {
    <li>{{ user.name }}</li>
  } @empty {
    <li class="empty">No users</li>
  }
</ul>
```

There is no `trackByFn` method anymore: the expression lives in the template. Use whatever property uniquely identifies your items.

## Step 2: Do not mix the id and the index
In the first version of this article, my `trackBy` function returned `item.id ?? index`. Do not do this:

```html
<!-- Anti-pattern -->
@for (user of users(); track user.id ?? $index) {
  <li>{{ user.name }}</li>
}
```

It mixes two kinds of keys in the same list:
- an item without an id is keyed by its **position**, so its key changes as soon as an item is added or removed before it, and Angular recreates its row (and moves its state to another item);
- an index can collide with an id: the item at index 0 without an id and the user whose id is `0` get the same key. When I tried it, Angular warned as soon as the list was updated: `NG0955: The provided track expression resulted in duplicated keys for a given collection. [...] key "0" at index "0" and "1".` (see [NG0955](https://angular.dev/errors/NG0955));
- if `id` is not optional in your type, the fallback is dead code that hides the real problem.

If some items have no id yet (an item created on the client and not saved yet, for example), give them one before adding them to the list, such as a [`crypto.randomUUID()`](https://developer.mozilla.org/docs/Web/API/Crypto/randomUUID), and keep it once the server answers.

## Step 3: Keep the identifiers when you update the list
When you modify the list, keep each item's identifier: an updated item keeps its id, and a new item gets a unique id before it is added. With a [signal](https://angular.dev/guide/signals), you set or update a new array and Angular does the rest:

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
  protected refresh(): void {
    this.users.set(this.usersService.getUsers());
  }

  /**
   * Adds a new user at the top of the list. The other users keep their objects.
   */
  protected addFirst(): void {
    this.users.update((users) => [{ id: this.nextId++, name: 'Rosa Quill' }, ...users]);
  }

  protected clear(): void {
    this.users.set([]);
  }
}
```

The methods are `protected` because only the template calls them, as the [style guide](https://angular.dev/style-guide) recommends. Thanks to `track user.id`, `refresh()` replaces every object without any DOM work, and `addFirst()` creates exactly one row.

## Why it matters
- **Performance.** With rows that contain components, images or directives, recreating them costs much more than six `<li>`.
- **Animations.** Because Angular knows which rows are really new, [`animate.enter` and `animate.leave`](https://angular.dev/guide/animations/enter-and-leave) run on those rows only.
- **State.** Focus, input values and child component state stay with the item the user is looking at.

## Conclusion
Track by a unique and stable identifier: not by the object itself, and not by `$index` when the list can change. Never mix an id and an index, and keep the identifiers when you update the list.

Source code of the article: [GitHub source code](https://github.com/jboinembalome/angular-trackby)

## References
- [Angular: @for block API](https://angular.dev/api/core/@for) — syntax, `track`, contextual variables and `@empty`.
- [Angular: Control flow](https://angular.dev/guide/templates/control-flow) — how `track` works and how to choose the expression.
- [Angular: NG0956](https://angular.dev/errors/NG0956) — the warning for a tracking expression that recreates the whole collection.
- [Angular: NG0955](https://angular.dev/errors/NG0955) — the warning for duplicated keys.
- [Angular: Signals](https://angular.dev/guide/signals) — `signal`, `set` and `update`.
- [Angular: Enter and leave animations](https://angular.dev/guide/animations/enter-and-leave) — `animate.enter` and `animate.leave`.
- [Angular coding style guide](https://angular.dev/style-guide) — `protected` members for templates, naming.
- [MDN: MutationObserver](https://developer.mozilla.org/docs/Web/API/MutationObserver) — the API used to count DOM mutations.
- [MDN: Object.is()](https://developer.mozilla.org/docs/Web/JavaScript/Reference/Global_Objects/Object/is) — identity comparison.
- [MDN: Crypto.randomUUID()](https://developer.mozilla.org/docs/Web/API/Crypto/randomUUID) — generating client-side identifiers.
- [Playwright](https://playwright.dev/) — the browser automation used by the measurement script.
