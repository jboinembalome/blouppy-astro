---
templateKey: 'blog-post'
title: 'The Composite pattern: menus, trees and a uniform interface'
date: 2027-01-05T09:00:00.000Z
author: Jimmy Boinembalome
authorimage: /img/jimmy.jpg
category: C#
topic: 'Architecture'
illustration: 1
categorycolor: bg-purple-100 text-purple-800
featuredpost: true
description: >-
  Learn the Composite pattern with a C# bundle price and a real Angular menu: one interface for leaves and groups, the safety and transparency trade-off, recursion and depth.
tags:
  - Development
  - C#
  - Design Patterns
  - Angular
  - TypeScript
---

Some data is a tree. A product bundle contains products and other bundles. A folder contains files and other folders. A menu contains actions and groups of actions. Code that walks such a tree tends to ask the same question on every node: is this a leaf or a container? And that question gets copied into every function that touches the tree.

The Composite pattern asks it once.


## A bundle price
The Composite is a structural pattern from the Gang of Four. It lets a client treat one object and a group of objects through the same interface. The **component** is that interface. A **leaf** implements it directly. A **composite** implements it by asking its children.

A shop sells products and bundles. A bundle can hold products and other bundles, and gets a discount. The one question the shop asks of every node is its price:

```csharp
public interface ICatalogItem
{
    decimal Price();
}

public sealed class Product(decimal price) : ICatalogItem
{
    public decimal Price() => price;
}

public sealed class Bundle(decimal discountRate) : ICatalogItem
{
    private readonly List<ICatalogItem> _items = [];

    public void Add(ICatalogItem item) => _items.Add(item);

    public decimal Price() => _items.Sum(x => x.Price()) * (1 - discountRate);
}
```

The client builds a tree and asks the root:

```csharp
var peripherals = new Bundle(discountRate: 0.05m);
peripherals.Add(new Product(80m));
peripherals.Add(new Product(20m));

var office = new Bundle(discountRate: 0.10m);
office.Add(new Product(300m));
office.Add(new Product(200m));
office.Add(peripherals);

var price = office.Price(); // (300 + 200 + 95) * 0.9 = 535.5
```

No loop over levels is written anywhere. `Bundle.Price()` asks its children, and a child that is a bundle does the same. The tree can be one level deep or ten; the client's line does not change.


## Safety or transparency
The book names a trade-off every Composite has to settle: where does `Add` live?

- **Safety.** On the composite only, as above. Nobody can add a child to a product, because `Product` has no `Add`. Code that edits the tree has to check the type, with `is Bundle bundle`.
- **Transparency.** On the component. Every node has `Add` and a list of children; a leaf returns an empty list and throws on `Add`. The client never checks a type, but the compiler no longer stops it from adding a child to a leaf.

In C#, safety is the usual choice. A pattern-matching check is cheap, and a method that throws `NotSupportedException` on half the implementations is a contract that lies. The uniform interface still holds where it matters: `Price()`.

TypeScript data shapes tend to go the other way. The design-system library of [Blouppy Starter](https://starter.blouppy.com/), `@blouppy/ui`, has one type for a menu row, `UiMenuItem`. A row is an action, a separator when `separator` is `true`, or a group when `items` is set. One recursive type, so it is the transparent variant.

The type check does not disappear, though. It moves to the template. The library does not render a menu model itself, so the caller loops over the rows and asks `@if (item.separator)` to pick a separator or a button. Transparency only moves the branch to the code that produces different markup for different nodes.

The data shape also allows any depth, but the rendering stops at one. The doc comment on `items` says so: nested rows are drawn inline, as a labelled group, "not as a fly-out submenu", because nothing in the app has one. That is a degenerate composite, and an honest one. One level is what a menu panel should have; a fly-out submenu is a different widget with its own keyboard rules.


## Recursion goes wrong deep down
A project-management app built on the Starter keeps its workspace sidenav as a tree of the same shape, patched as projects are created and renamed. Finding a node is a depth-first search:

```ts
private tryGetMenuItemById(menuItems: WorkspaceSidenavItem[], menuItemId: string): WorkspaceSidenavItem | null {
  for (const menuItem of menuItems) {
    if (menuItem.id === menuItemId) {
      return menuItem;
    }

    const found = menuItem.items ? this.tryGetMenuItemById(menuItem.items, menuItemId) : null;

    if (found) {
      return found;
    }
  }

  return null;
}
```

The comment above it records the bug it replaced. The previous version called `find` with a predicate that recursed. So a match anywhere below a node made `find` return that node, not the descendant. Nobody noticed, because the only ids ever looked up were the two root groups. The first project attached one level lower would have landed on the wrong branch.

That is the risk of recursion in a Composite: the code is short, and its mistakes only show at a depth the tests did not reach. A test of a recursive operation needs a tree deeper than the one it starts from. Two more limits come with depth. A composite added to itself, directly or through a child, recurses until the stack overflows, so `Add` should refuse it when the tree comes from user input. And when the domain has a real ceiling on depth, a check in `Add` costs less than a layout that breaks at the fourth level.


## When two loops are simpler
The Starter's settings sidenav lists headings with links under them, like a menu. It does not use a Composite. It declares two types, a group with `entries` and an entry with a label and a path, and the template is two nested `@for` loops. The structure is fixed by the product, and no entry will ever hold entries. The compiler knows the depth, and the template has no branch on the kind of node.

A Composite earns its place when the depth is not known in advance (folders, nested bundles, an org chart), when one operation applies to the whole tree (a price, a size, a permission), and when leaves and groups can be used in the same places. When the depth is fixed at one or two, or when every caller branches on the kind of node anyway, two plain types are easier to read and to type.


## References
- [Composite](https://refactoring.guru/design-patterns/composite) — Refactoring.Guru: the pattern's structure, with C# and TypeScript examples.
- [Menu and menubar pattern](https://www.w3.org/WAI/ARIA/apg/patterns/menubar/) — WAI-ARIA Authoring Practices: the roles a menu and its groups carry.
- [Building overlays on the Angular CDK](/blog/2026-07-21-building-overlays-on-the-angular-cdk/) — why `ui-menu` projects its rows instead of rendering a model.
