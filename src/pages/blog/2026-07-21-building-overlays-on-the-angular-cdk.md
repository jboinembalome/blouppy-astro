---
templateKey: 'blog-post'
title: 'Building overlays on the Angular CDK: tooltip, drawer and menu'
date: 2026-07-21T09:00:00.000Z
updated: 2026-11-07T09:00:00.000Z
author: Jimmy Boinembalome
authorimage: /img/jimmy.jpg
category: Angular
topic: 'Front end'
illustration: 2
categorycolor: bg-red-100 text-red-800
featuredpost: true
featuredimage: /img/building-overlays-on-the-angular-cdk.jpg
description: >-
  Learn how to build accessible, well-positioned and themeable tooltips, drawers and menus on the Angular CDK, and which CDK primitive fits each one.
tags:
  - Development
  - Angular
  - TypeScript
  - Accessibility
  - Angular CDK
---

When we remove a component library from an Angular app, the last things left are often the overlays: tooltip, dialog, drawer, menu. They all position a panel, dim the page or not, trap focus or not, close on `Escape` and restore focus. Written separately, they drift apart.

The [Angular CDK](https://angular.dev/api/cdk) gives us the primitives, not the decisions. In this article, we will choose the CDK part that fits each overlay, write the shared layer once, and build a tooltip, a drawer and a menu on top of it.


## Which parts of the CDK?
The CDK has two levels: `overlay`, `a11y` and `portal` are mechanism; `dialog`, `menu` and `listbox` are unstyled behaviour built on them:

| Use case | Built on | Why |
| --- | --- | --- |
| Modal, opened from TypeScript | `cdk/dialog` | It already is what we would have written |
| Panel anchored to a trigger | bare `cdk/overlay` | `cdk/dialog` positions globally; there is no CDK "popover" |
| Menu | `cdk/menu` | Typeahead, roving focus and the menu stack are the expensive half |
| Tooltip | bare `cdk/overlay` | It is not a dialog, a menu or a listbox |

There is no Angular Material: the only CDK stylesheet, `overlay-prebuilt.css`, positions the container, pane and backdrop without styling them.


## One surface, one position vocabulary
Every floating panel should be the same material, so `overlay-surface.ts` exports it as `UI_OVERLAY_SURFACE`, a string of Tailwind classes over the theme tokens (`rounded-lg border border-(--blouppy-border) bg-(--blouppy-card) … shadow-lg`). It is a **constant, not a base component**: the modal subclasses the CDK's `CdkDialogContainer`, so it cannot share a host with our anchored panel, but both can share a class string.

For positioning, the CDK's [`FlexibleConnectedPositionStrategy`](https://material.angular.dev/cdk/overlay/overview) walks a list of positions and takes the first that fits. Instead of raw `ConnectedPosition` objects, `overlay-position.ts` offers a small vocabulary:

```typescript
export type UiOverlayPlacement = 'bottom-start' | 'bottom-end' | 'bottom' | 'top-start' | 'top-end' | 'top';

export const UI_OVERLAY_OFFSET = 8;

export function uiConnectedPositions(placement: UiOverlayPlacement, offset: number = UI_OVERLAY_OFFSET): ConnectedPosition[] {
  const [side, alignment] = split(placement);
  const opposite: Side = side === 'bottom' ? 'top' : 'bottom';
  const alternatives: Alignment[] = alignment === 'center' ? ['start', 'end'] : [alignment === 'start' ? 'end' : 'start', 'center'];

  return [
    position(side, alignment, offset),
    position(opposite, alignment, offset),
    ...alternatives.flatMap(other => [position(side, other, offset), position(opposite, other, offset)]),
  ];
}
```

The order *is* the flip behaviour: flip the **side** first (a dropdown that opens upwards is still the same dropdown), and only then change the alignment. There is no `left`/`right`, because a panel that opens sideways is a submenu, which `cdk/menu` owns. Tooltip, menu, popover and select all use it, so they flip the same way.


## The anchored panel
There is no CDK primitive between "a global dialog" and "raw overlay", so we write the missing piece: a `uiAnchoredOverlay` directive for popovers and selects. Here is the heart of its `open()`, trimmed:

```typescript
const overlayRef = createOverlayRef(this._injector, {
  positionStrategy: createFlexibleConnectedPositionStrategy(this._injector, this._trigger)
    .withPush(true)
    .withFlexibleDimensions(false)
    .withViewportMargin(UI_OVERLAY_OFFSET)
    .withPositions(uiConnectedPositions(this.overlayPlacement(), this.overlayOffset())),
  scrollStrategy: this._scrollStrategy(),
  hasBackdrop: false,
  // ... minWidth, maxWidth and maxHeight bounded by the trigger and the viewport
  disposeOnNavigation: true,
});

overlayRef.attach(new TemplatePortal(this.uiAnchoredOverlay(), this._viewContainerRef));
overlayRef.updatePosition();
```

- **Push is the last resort**, and flexible dimensions stay off: a nudged panel is readable, a shrunk one is not.
- **`hasBackdrop: false`.** Dismissal comes from `outsidePointerEvents()` instead, so the click that closes a panel still reaches whatever was clicked.
- **`updatePosition()` right after `attach()`.** The CDK places the pane in `afterNextRender`; a listbox scrolling to its selected option before that once left a select's list at the top-left of the viewport.
- **`Escape`**, read from `overlayRef.keydownEvents()`, stops propagation, so one press closes one layer: a select inside a modal must not take the modal down with it.

- **Focus restore.** On close, focus goes back to the trigger only if the panel still had it, or if nothing has it: a click on another control has already decided where focus belongs.

A consuming app adds `@use '@angular/cdk/overlay-prebuilt.css';` to its `styles.scss`. There must be one copy of `@angular/cdk`, since `OverlayContainer` is `providedIn: 'root'` and two copies would mean two overlay containers; one lockfile for all the front-end apps guarantees it.


## The tooltip: the shakedown
The tooltip was built first, to test this layer. The position vocabulary and the scroll strategies carried over unchanged; `uiAnchoredOverlay` did not, and was never meant to: it toggles on click, traps focus and announces `aria-expanded`, while a tooltip never takes focus and is a **description**, not a control.

- **`AriaDescriber`**, called from an `effect()` that removes the description on cleanup, points `aria-describedby` at a hidden copy of the message that exists whether or not the tooltip is on screen; setting the attribute only while visible races the screen reader's announcement. The visible `ui-tooltip` is therefore `aria-hidden`.
- **No tooltip on touch.** `onPointerEnter` returns early for a `touch` pointer: there is no hover, and the long press belongs to the browser. So what a tooltip says must be reachable another way, such as an icon button's `aria-label` (see the [WAI-ARIA tooltip pattern](https://www.w3.org/WAI/ARIA/apg/patterns/tooltip/)).
- **Only a keyboard arrival shows it**, through the `keyboard` origin of [`FocusMonitor`](https://material.angular.dev/cdk/a11y/overview): a click also focuses a button.
- **The delay is a constant** (`UI_TOOLTIP_DELAY`, 400 ms), not an input: twenty-eight tooltips each opening on their own schedule are twenty-eight decisions nobody made. Keyboard focus does not wait.

It closes on scroll (`createCloseScrollStrategy`), and its `Escape` listener deliberately does *not* stop propagation: a tooltip is not a layer, so the same press must still close the dialog around it.


## The drawer: declarative, not the dialog service
The dialog service with an edge position strategy looks like the obvious choice, but `cdk/dialog` renders into the CDK's global overlay container, always over the whole viewport. The app's sidenav is a modal on a narrow screen and **part of the layout** on a wide one, and a settings panel must dim its own view, not the page.

So the drawer is a component that renders where it is declared. Its `open` is a `model()`, so a trigger elsewhere can close it and see that it closed; `mode` is `'over' | 'side'` and `scope` is `'container' | 'viewport'`. The host classes follow from them:

```typescript
protected readonly hostClasses = computed(() => {
  if (!this.open()) {
    return 'hidden';
  }

  if (this.mode() === 'side') {
    return 'contents';
  }

  return this.scope() === 'viewport' ? 'fixed inset-0 z-50' : 'absolute inset-0 z-20';
});
```

A closed drawer is **hidden, not removed**, so its content keeps its state. In `side` mode the host becomes `contents`, so the panel is a direct flex child of the caller's row and takes its space from the layout. And `scope="container"` with `absolute inset-0` dims only the nearest positioned ancestor.

The behaviour is still the CDK's. In an [`afterRenderEffect`](https://angular.dev/api/core/afterRenderEffect), which does not run on the server, an open `over` drawer remembers the active element, traps focus with `FocusTrapFactory` and `focusInitialElementWhenReady()`, and blocks page scroll with `createBlockScrollStrategy`. When nothing inside is tabbable, it focuses its own panel, otherwise its `keydown` would never hear `Escape`.

The app shell uses one drawer for both screen sizes, with `sidenavMode = computed(() => (this.isScreenSmall() ? 'over' : 'side'))`.


## The menu: cdk/menu as host directives
For the menu, we write no keyboard handling. [`CdkMenu`, `CdkMenuItem` and `CdkMenuTrigger`](https://material.angular.dev/cdk/menu/overview) become [host directives](https://angular.dev/guide/directives/directive-composition-api), which bring `role="menu"`, roving `tabindex`, arrows with wrap-around, Home/End, typeahead, `Escape`, the menu stack and focus restore. Here is the row:

```typescript
@Directive({
  selector: 'button[uiMenuItem], a[uiMenuItem]',
  exportAs: 'uiMenuItem',
  hostDirectives: [
    {
      directive: CdkMenuItem,
      inputs: ['cdkMenuItemDisabled: disabled', 'cdkMenuitemTypeaheadLabel: typeaheadLabel'],
      outputs: ['cdkMenuItemTriggered: triggered'],
    },
  ],
  host: { '[class]': 'classes()' },
})
export class MenuItemDirective {
  public readonly danger = input(false);
}
```

The trigger, `MenuTriggerDirective`, has the same shape over `CdkMenuTrigger` (`cdkMenuTriggerFor: uiMenuTriggerFor`), plus a `uiMenuPlacement` input that an `effect()` writes into the CDK's `menuPosition` as `uiConnectedPositions(this.uiMenuPlacement())`. Two things to know before writing one:

- **`CdkMenuTrigger` opens its own overlay**, so the menu must *not* also go through `uiAnchoredOverlay`.
- **Rows must be projected, never rendered from an `items` input.** `CdkMenu` finds its rows with a content query, which does not reach into a component's own view. A `ui-menu` rendering `[items]` itself would look right and have no keyboard behaviour whatsoever.

Here is a real call site (a navigating row would be the caller's own `<a uiMenuItem [routerLink]="…">`, so the library needs no router):

```html
<button uiButton type="button" variant="text" [uiMenuTriggerFor]="webhookMenu" uiMenuPlacement="bottom-end" …>…</button>

<ng-template #webhookMenu>
  <ui-menu [ariaLabel]="'webhooks.rowActions' | transloco: { url: webhook().url }">
    @for (item of menuItems(); track item.id) {
      <button uiMenuItem type="button" [danger]="item.danger ?? false" (triggered)="item.command?.()">
        <ui-menu-item-content [item]="item" />
      </button>
    }
  </ui-menu>
</ng-template>
```

The `@for` lives in the caller's template, so the rows are [projected content](https://angular.dev/guide/components/content-projection) and the CDK adopts them.


## Conclusion
The Angular CDK covers the hard behaviour: positioning, focus traps, `aria-describedby`, scroll strategies and the menu keyboard contract. It leaves us the decisions: which primitive fits which overlay, one surface and one position vocabulary for all, and when *not* to reuse our own abstraction. The tooltip skips the anchored directive because it is a description, not a control; the drawer skips the dialog service because it lives in the layout; and the menu skips both because `cdk/menu` already owns its overlay.

This is how the overlays are built in [Blouppy Starter](https://starter.blouppy.com/).


## References
- [Overlay](https://material.angular.dev/cdk/overlay/overview) (Angular CDK) — overlays, position strategies and scroll strategies.
- [Menu](https://material.angular.dev/cdk/menu/overview) (Angular CDK) — `CdkMenu`, `CdkMenuItem`, `CdkMenuTrigger` and their keyboard behaviour.
- [Accessibility](https://material.angular.dev/cdk/a11y/overview) (Angular CDK) — `FocusMonitor`, `AriaDescriber` and `FocusTrap`.
- [Directive composition API](https://angular.dev/guide/directives/directive-composition-api) (angular.dev) — `hostDirectives` and input/output aliasing.
- [`afterRenderEffect`](https://angular.dev/api/core/afterRenderEffect) (angular.dev) — DOM work after rendering, skipped on the server.
- [Tooltip pattern](https://www.w3.org/WAI/ARIA/apg/patterns/tooltip/) and [Menu button pattern](https://www.w3.org/WAI/ARIA/apg/patterns/menu-button/) (WAI-ARIA Authoring Practices) — the expected roles and keyboard interactions.
- [A design system of its own](https://docs.starter.blouppy.com/choices/design-system/) (Blouppy Starter docs) — why the Starter owns its components.
