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

Some data is a tree. A product bundle contains products and other bundles. A folder contains files and other folders. A menu contains actions and groups of actions. The code that walks such a tree tends to start with a question on every node: is this a leaf or a container? That question gets copied into every function that touches the tree.

In this article, we will look at the **Composite** pattern: its shape on a small C# example, a bundle whose price is the sum of its parts, then a real one, the menu items of `@blouppy/ui`, the design-system library of [Blouppy Starter](https://starter.blouppy.com/). We will look at the trade-off between a uniform interface and type-checking, at recursion and its depth, and at when a plain list with groups is the simpler choice.


## The pattern
The Composite is a **structural** pattern from the Gang of Four book. It composes objects into tree structures and lets a client treat a single object and a group of objects through the same interface.

There are three roles:

- **The component** is the shared interface: what a client may ask of any node.
- **The leaf** implements it directly. It has no children.
- **The composite** implements it by delegating to its children, and usually adds a way to hold them.

The client holds a reference to the root and calls one method. Whether the root is a leaf or a deep tree does not change the client's code.


## A bundle price in C#
A shop sells products and bundles. A bundle can contain products and other bundles, and gets a discount. The component is the one question the shop asks of every node:

```csharp
public interface ICatalogItem
{
    string Name { get; }

    decimal Price();
}
```

The leaf answers with its own value:

```csharp
public sealed class Product(string name, decimal price) : ICatalogItem
{
    public string Name { get; } = name;

    public decimal Price()
    {
        return price;
    }
}
```

The composite answers by asking its children, and then applies its own rule:

```csharp
public sealed class Bundle(string name, decimal discountRate) : ICatalogItem
{
    private readonly List<ICatalogItem> _items = [];

    public string Name { get; } = name;

    public IReadOnlyList<ICatalogItem> Items => _items;

    public void Add(ICatalogItem item)
    {
        ArgumentNullException.ThrowIfNull(item);

        _items.Add(item);
    }

    public decimal Price()
    {
        var total = _items.Sum(x => x.Price());

        return total * (1 - discountRate);
    }
}
```

The client builds a tree and calls `Price()` on the root:

```csharp
var office = new Bundle("Home office", discountRate: 0.10m);
office.Add(new Product("Desk", 300m));
office.Add(new Product("Chair", 200m));

var peripherals = new Bundle("Peripherals", discountRate: 0.05m);
peripherals.Add(new Product("Keyboard", 80m));
peripherals.Add(new Product("Mouse", 20m));
office.Add(peripherals);

var price = office.Price(); // (300 + 200 + 95) * 0.9 = 535.5
```

No loop over levels is written anywhere: `Bundle.Price()` asks its children, and a child that is a bundle does the same. The tree can be one level deep or ten; the client's line does not change.


## Safety or transparency
The Gang of Four book names a trade-off that every Composite has to settle: where do `Add` and `Items` live?

- **Safety.** They live on the composite only, as above. A client cannot add a child to a product, because `Product` has no `Add`. The cost is that code which builds or edits the tree has to know which type it holds, and checks it with `is Bundle bundle`.
- **Transparency.** They live on the component. Every node has `Add` and `Items`, a leaf returns an empty list and throws (or ignores) on `Add`. The client never checks a type, and in exchange the compiler no longer stops it from adding a child to a leaf.

In C#, safety is the usual choice: a type check with pattern matching is cheap and readable, and a method that throws `NotSupportedException` on half the implementations is a contract that lies. The uniform interface still holds for the operation that matters, `Price()`, which is what the pattern is for.

TypeScript data shapes tend to go the other way.


## A menu item that may hold menu items
`@blouppy/ui` replaced PrimeNG's `MenuItem` with its own type, `UiMenuItem`, in `menu/menu-item.ts`. Trimmed to the fields that matter here:

```ts
export interface UiMenuItem {
  id?: string;
  label?: string;
  icon?: string;
  disabled?: boolean;
  /** A rule between groups. A separator row carries nothing else. */
  separator?: boolean;
  danger?: boolean;
  /** Nested rows, rendered inline as a labelled group, not as a fly-out submenu. */
  items?: UiMenuItem[];
  command?: () => void;
}
```

This is the transparent variant of the pattern. There is one type for an action, a separator and a group; a node is a group because its `items` is set, a separator because `separator` is `true`. The type is recursive, so nothing stops a model from nesting groups inside groups.

The uniformity pays off in `MenuItemContentComponent`, which takes a `UiMenuItem` and lays out its icon, label, badge and shortcut, so every action menu renders its rows identically.

The cost of transparency shows up where the model is rendered. The library does not render a model itself: `ui-menu` only projects its rows, because `CdkMenu` finds them with a content query that would not reach rows rendered from the component's own template. The [article on overlays](/blog/2026-07-21-building-overlays-on-the-angular-cdk/) explains that constraint. So the `@for` over the model lives in the caller, and the caller is the one that asks "which kind of node is this?". The playground's menu example does exactly that:

```html
<ui-menu ariaLabel="Member actions">
  @for (item of items(); track item.id) {
    @if (item.separator) {
      <ui-menu-separator />
    } @else {
      <button uiMenuItem type="button" [danger]="item.danger ?? false" (triggered)="item.command?.()">
        <ui-menu-item-content [item]="item" />
      </button>
    }
  }
</ui-menu>
```

The type is uniform; the rendering still branches. That is the honest picture of transparency: the type check does not disappear, it moves to the code that has to produce different markup for different nodes.


## Groups: one level, on purpose
On the markup side, a group is `MenuGroupComponent`, a component with a required `label` and a slot for rows:

```ts
@Component({
  selector: 'ui-menu-group',
  host: {
    role: 'group',
    class: 'block',
    '[attr.aria-label]': 'label()',
  },
  template: `
    <p class="px-3 pt-2 pb-1 text-xs font-semibold" aria-hidden="true">{{ label() }}</p>
    <ng-content />
  `,
})
export class MenuGroupComponent {
  public readonly label = input.required<string>();
}
```

The account menu of the Starter app, behind the avatar, is written this way: a header, a separator, an _Organization_ group with the organizations to switch to and a link to its settings, another separator, and an _Account_ group with the settings and _Sign out_. Its rows are written in the template rather than built from a `UiMenuItem[]`, because some are router links and the library does not depend on `@angular/router`.

Two things are worth being exact about.

**Nothing recurses.** No component in the library walks `items`, and no call site in the Starter app sets it: the three action menus (a webhook's, a delivery's and a member's) pass flat lists, and the account menu writes its groups as markup. The doc comment on `items` says why: it is rendered "inline, as a labelled group, not as a fly-out submenu", and a real submenu (`cdkMenuTriggerFor` on a row) "is not modelled here, because nothing in the app has one". A group inside a group is never drawn.

So this is a **degenerate** composite: the data shape allows any depth, the rendering stops at one. That is still the pattern, a node and a group of nodes behind one type, and one level is what a menu panel should have. A fly-out submenu is a different widget with its own keyboard rules.

**The roles carry the structure.** `CdkMenu` gives the panel `role="menu"`; a group is `role="group"` named by its `aria-label`, and its visible heading is `aria-hidden` so a screen reader does not read the label twice; a separator is its own component with `role="separator"`, which is, besides its items, the only child role a menu accepts.


## A tree that does go deeper
A project-management app built on the Starter keeps its workspace sidenav as a tree of `WorkspaceSidenavItem`, a type with the same shape as `UiMenuItem`: optional `items`, and a `parentId` naming the branch a node belongs under. A service patches it in place as projects are created, renamed and deleted, and every operation on it recurses.

Finding a node is a depth-first search:

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

The comment above it records the bug it replaced. The previous version called `find` with a predicate that recursed, so a match anywhere below a node made `find` return that node rather than the descendant. Nobody noticed, because the only ids ever looked up were the two root groups; the first project attached one level lower would have landed on the wrong branch.

That is the risk of recursion in a Composite: the code is short, and its mistakes only show at a depth the tests did not reach. A test for a recursive operation needs a tree at least two levels deeper than the one it starts from.

Two more limits come with depth:

- **Cycles.** A composite that can be added to itself, directly or through a child, makes `Price()` recurse until the stack overflows. When the tree comes from user input, `Add` should refuse an item that already contains the composite.
- **Depth.** When the domain has a real ceiling, write it down. A check in `Add` costs less than a layout that breaks at the fourth level.

The same app has a domain example of the pattern too. A scope's position on its hill is computed from its direct issues, and a level-two issue's from its sub-issues: a parent's value is derived from its children, like the bundle's price. Only a scope with no issue is placed by hand, which is the leaf.


## When a fixed structure is simpler
The Starter's settings sidenav lists the same kind of thing as a menu: headings with links under them. It does not use a Composite. `settings-menu.ts` declares two types, `SettingsMenuGroup` with a `level`, a heading and `entries`, and `SettingsMenuEntry` with an id, a label and a path. The template is two nested `@for` loops, an `h3` per group and a `ul` labelled by it.

That is the safe variant taken to its end: two types, two levels, and no node that could be either. It is the better choice here, because the structure is fixed by the product (workspace, organization, account) and no entry will ever hold entries. The compiler knows the depth, and the template has no branch on the kind of node.

A Composite earns its place when:

- **the depth is not known in advance**, like folders, nested bundles or an organization chart;
- **one operation applies to the whole tree**, like a price, a size or a permission check, and its callers should not care how deep it goes;
- **leaves and groups are interchangeable** where they are used, so a bundle can go anywhere a product can.

It is too much when:

- **the depth is fixed** at one or two. A list of groups with a list of entries in each, or a flat list whose items carry a `group` key and are grouped at render time, is easier to read and to type.
- **leaves and groups are used differently** everywhere. If every caller branches on the kind of node anyway, the shared interface buys nothing.
- **the only operation is rendering.** A template already nests; a `@for` inside a `@for` is not a design problem.

The costs are real: the code that edits the tree still type-checks, recursion makes deep bugs cheap to write and expensive to find, and the transparent variant accepts shapes the rendering never draws, like a group in a group.


## Conclusion
The Composite gives leaves and groups one interface, so a client asks the root and the tree answers, however deep it is. In C#, the safe variant keeps `Add` on the composite and lets pattern matching handle the rare edit; in a TypeScript data shape like `UiMenuItem`, the transparent variant is natural, and the type checks move into the template that renders it. Keep the depth honest: `@blouppy/ui` models nested items and draws one level of labelled groups, and says so. When the structure is fixed, two plain types and two loops are simpler than a tree.

`UiMenuItem`, `ui-menu-group` and the settings menu are in [Blouppy Starter](https://starter.blouppy.com/); the [overlays article](/blog/2026-07-21-building-overlays-on-the-angular-cdk/) covers how the menu itself is built on the Angular CDK.


## References
- [Composite (Refactoring.Guru)](https://refactoring.guru/design-patterns/composite) — the pattern's structure, with C# and TypeScript examples.
- [Menu (Angular CDK)](https://material.angular.dev/cdk/menu/overview) — `CdkMenu`, `CdkMenuItem` and `CdkMenuTrigger`, the behaviour behind `ui-menu`.
- [Menu and menubar pattern (WAI-ARIA Authoring Practices)](https://www.w3.org/WAI/ARIA/apg/patterns/menubar/) — the roles a menu, its groups and its separators are expected to carry.
- [Pattern matching (Microsoft Learn)](https://learn.microsoft.com/dotnet/csharp/fundamentals/functional/pattern-matching) — the `is` checks the safe variant relies on.
- [Building overlays on the Angular CDK](/blog/2026-07-21-building-overlays-on-the-angular-cdk/) — why `ui-menu` projects its rows instead of rendering an `items` input.
