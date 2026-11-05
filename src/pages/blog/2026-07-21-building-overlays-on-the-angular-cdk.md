---
templateKey: 'blog-post'
title: 'Building overlays on the Angular CDK: tooltip, drawer and menu'
date: 2026-07-21T09:00:00.000Z
author: Jimmy Boinembalome
authorimage: /img/jimmy.jpg
category: Angular
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

When we remove a component library from an Angular app, the last things left are often overlays: the tooltip, the dialog, the drawer, the menu. They all position a panel, dim the page or not, trap focus or not, close on `Escape` and put focus back. Written separately, they become subtly different overlays.

The Angular CDK gives us the primitives, but it does not make the decisions for us. In this article, we will choose which CDK parts to use for each overlay, write the shared layer once, and then build a tooltip, a drawer and a menu on top of it and see *why* each one ended up shaped the way it is.


## Which parts of the CDK?
The CDK has two levels: `overlay`, `a11y` and `portal` are mechanism; `dialog`, `menu` and `listbox` are unstyled behaviour built on them. Let's compare them per use case:

| Use case | Built on | Why |
| --- | --- | --- |
| Modal, opened from TypeScript | `cdk/dialog` | It already is what we would have written |
| Panel anchored to a trigger | bare `cdk/overlay` | `cdk/dialog` positions globally; there is no CDK "popover" |
| Menu | `cdk/menu` | Typeahead, roving focus and the menu stack are the expensive half |
| Tooltip | bare `cdk/overlay` | It is not a dialog, a menu or a listbox |

And no Angular Material: the only CDK stylesheet is `@angular/cdk/overlay-prebuilt.css`, which positions the container, the pane and the backdrop without styling them. The theme stays ours.


## One surface, one position vocabulary
Every floating panel should be the same material. Here is the surface, from `overlay-surface.ts`:

```typescript
export const UI_OVERLAY_SURFACE = 'rounded-lg border border-(--blouppy-border) bg-(--blouppy-card) text-(--blouppy-text) shadow-lg';

export const UI_OVERLAY_SCRIM = 'bg-(--blouppy-scrim)';
```

It is a **constant, not a base component**. The anchored panel is a component of ours, but the modal is a subclass of the CDK's `CdkDialogContainer`; they cannot share a host. Tailwind classes over CSS tokens let both be the same surface, and a theme switch repaints both.

Next, positioning. The CDK's `FlexibleConnectedPositionStrategy` walks a list of positions and takes the first that fits. Let's give it a small vocabulary instead of raw `ConnectedPosition` objects, in `overlay-position.ts`:

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

- The order *is* the flip behaviour: flip the **side** first (a dropdown that opens upwards is still the same dropdown), and only then swap the alignment.
- There is no `left`/`right`. A panel that opens sideways is a submenu, and `cdk/menu` owns that case.
- Tooltip, menu, popover and select all use it, so they flip the same way.


## The anchored panel
There is no CDK primitive between "a global dialog" and "raw overlay", so we write the missing piece: a `uiAnchoredOverlay` directive for popovers and selects. Here is the heart of its `open()`:

```typescript
const overlayRef = createOverlayRef(this._injector, {
  positionStrategy: createFlexibleConnectedPositionStrategy(this._injector, this._trigger)
    .withPush(true)
    .withFlexibleDimensions(false)
    .withViewportMargin(UI_OVERLAY_OFFSET)
    .withPositions(uiConnectedPositions(this.overlayPlacement(), this.overlayOffset())),
  scrollStrategy: this._scrollStrategy(),
  hasBackdrop: false,
  disposeOnNavigation: true,
});

overlayRef.attach(new TemplatePortal(this.uiAnchoredOverlay(), this._viewContainerRef));
overlayRef.updatePosition();

```

- **Push is the last resort**, and flexible dimensions stay off: a panel nudged on screen is readable, one shrunk to fit is not.
- **`hasBackdrop: false`.** Dismissal comes from `outsidePointerEvents()` instead, so the click that closes a panel still reaches whatever was actually clicked.
- **`updatePosition()` right after `attach()`.** The CDK places the pane in `afterNextRender`, after the content's own microtasks; a listbox scrolling to its selected option in an unplaced pane left a select's list at the top-left of the viewport.
- **`Escape`**, read from `overlayRef.keydownEvents()`, stops propagation, so one press closes one layer: a select inside a modal must not take the modal down with it.

On close, the directive gives focus back to the trigger only if the panel still had it, or if nothing does. A click on another control has already decided where focus belongs.


## What a consuming app has to do
One line, next to the token imports in `styles.scss`:

```css
@use '@angular/cdk/overlay-prebuilt.css';
```

`@angular/cdk` is a **dependency** of the UI library itself, not a peer. One copy still matters: `OverlayContainer` is `providedIn: 'root'`, so two copies would mean two overlay containers. One lockfile for all the front-end apps guarantees one resolution.


## The tooltip: the shakedown
The tooltip was the first thing built on this layer, precisely to test it. The result: the position vocabulary and the scroll strategies carried over unchanged; `uiAnchoredOverlay` did not, and was never meant to. That directive toggles on click, traps focus and announces `aria-expanded`, while a tooltip opens on hover and keyboard focus, never takes focus, and is a **description**, not a control.

Here are the parts of `TooltipDirective` that carry the decisions:

```typescript
export const UI_TOOLTIP_DELAY = 400;

export class TooltipDirective {
  /** The text. Blank means no tooltip at all — nothing shown, nothing described. */
  public readonly uiTooltip = input('');
  /** Which side it opens towards. */
  public readonly tooltipPlacement = input<UiOverlayPlacement>('top');

  private readonly _message = computed(() => this.uiTooltip().trim());

  constructor() {
    this._focusMonitor
      .monitor(this._trigger)
      .pipe(takeUntilDestroyed())
      .subscribe(origin => {
        if (origin === 'keyboard') {
          this._open();
        } else if (!origin) {
          this.hide();
        }
      });

    effect(onCleanup => {
      const message = this._message();
      const element = this._trigger.nativeElement;

      if (!message || this._repeatsItsOwnText(message)) {
        return;
      }

      this._ariaDescriber.describe(element, message);
      onCleanup(() => this._ariaDescriber.removeDescription(element, message));
    });
  }
}
```

- **`FocusMonitor` origin.** Only a *keyboard* arrival shows it.
- **`AriaDescriber`** points `aria-describedby` at a hidden copy of the message that exists whether or not the tooltip is on screen. Setting the attribute only while visible races the screen reader's announcement on arrival. The visible `ui-tooltip` is `aria-hidden` in consequence: one copy of the words, not two.
- **No tooltip on touch.** `onPointerEnter` returns early when `pointerType` is `touch`: there is no hover, the tap fires the control's own action, and the long press belongs to the browser. So the rule for every call site: what the tooltip says must be reachable another way, which for an icon-only button is its `aria-label`.
- **The delay is a constant, not an input** (`UI_TOOLTIP_DELAY`). Twenty-eight tooltips each opening on their own schedule are twenty-eight decisions nobody made. Keyboard focus does not wait.

It closes on scroll (`createCloseScrollStrategy`), and its `Escape` listener is deliberately *not* stopped: a tooltip is not a layer, so the same press must still close the dialog around it.

> **_Note:_**  `@angular/cdk/a11y` adds about 15 kB to the initial bundle. Every overlay after the tooltip uses the same module, so it is paid once. 👍


## The drawer: declarative, not the dialog service
The obvious guess is the dialog service with an edge position strategy. The call sites proved it wrong: `cdk/dialog` renders into the CDK's single global overlay container, which is always over the page and always the full viewport. But the app's sidenav is a modal on a narrow screen and **part of the layout** on a wide one, and a settings panel must dim its own view, not the whole page.

So the drawer is a component that renders where it is declared. Here are its inputs:

```typescript
export class DrawerComponent {
  /** Whether the panel is on screen. Two-way, so a trigger elsewhere can close it and see that it closed. */
  public readonly open = model(false);
  /** `over` floats above the view behind a scrim; `side` is part of the layout and takes its space. */
  public readonly mode = input<UiDrawerMode>('over');
  /** What it covers: its own container, or the whole viewport. */
  public readonly scope = input<UiDrawerScope>('container');
  /** The panel's accessible name. Required of an `over` drawer, which is a dialog. */
  public readonly ariaLabel = input<string>();

  protected readonly isModal = computed(() => this.open() && this.mode() === 'over');

  protected readonly hostClasses = computed(() => {
    if (!this.open()) {
      return 'hidden';
    }

    if (this.mode() === 'side') {
      return 'contents';
    }

    return this.scope() === 'viewport' ? 'fixed inset-0 z-50' : 'absolute inset-0 z-20';
  });
}
```

- A closed drawer is **hidden, not emptied**, so switching between `over` and `side` does not rebuild its content.
- In `side` mode the host becomes `contents`, so the panel is a direct flex child of the caller's row and takes its space from the layout, with no fixed panel and no margin to compensate.
- `scope="container"` with `absolute inset-0` dims only the nearest positioned ancestor.

The behaviour is still the CDK's. In an `afterRenderEffect` (skipped on the server, so it is safe on prerendered sites), an open `over` drawer remembers the active element, creates a trap with `FocusTrapFactory`, calls `focusInitialElementWhenReady()` and enables `createBlockScrollStrategy`. When the trap finds nothing tabbable, the drawer focuses its own panel: otherwise focus stays on the opener, where the drawer's `keydown` never hears `Escape`. Only the focus *restore* in `_release()` is ours, with the same rule as the anchored panel.

The app shell uses one drawer for both screens, with `[mode]="sidenavMode()"` and `sidenavMode = computed(() => (this.isScreenSmall() ? 'over' : 'side'))`. Since nothing goes through the overlay container, the drawer needs no stylesheet at all.


## The menu: cdk/menu as host directives
For the menu, we do not write keyboard handling at all. `CdkMenu`, `CdkMenuItem` and `CdkMenuTrigger` become host directives, which bring `role="menu"`, roving `tabindex`, arrows with wrap-around, Home/End, typeahead, `Escape`, the menu stack and focus restore. Here is the row:

```typescript
@Directive({
  selector: 'button[uiMenuItem], a[uiMenuItem]',
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
  /** Marks the row as destructive. Colour only, and only on hover and focus. */
  public readonly danger = input(false);
}
```

The trigger, `MenuTriggerDirective`, is the same shape over `CdkMenuTrigger` (`cdkMenuTriggerFor: uiMenuTriggerFor`), and only adds a `uiMenuPlacement` input that an `effect()` writes into the CDK's `menuPosition` as `uiConnectedPositions(this.uiMenuPlacement())`.

Two things to know before writing one:

- **`CdkMenuTrigger` opens its own overlay.** So the menu must *not* go through `uiAnchoredOverlay`: two overlays would open, and only one would have the keyboard behaviour.
- **Rows must be projected, never rendered from an `items` input.** `CdkMenu` finds its rows with a content query, which does not reach into a component's own view. A `ui-menu` rendering `[items]` itself would look exactly right and have no keyboard behaviour whatsoever. 😉

Bonus: the library needs no `@angular/router`; a navigating row is the caller's own `<a uiMenuItem [routerLink]="…">`. Here is a real call site:

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

The `@for` lives in the caller's template, so the rows are content children of `ui-menu` and the CDK adopts them.


## Conclusion
The Angular CDK covers the hard, testable behaviour: positioning with flip and push, focus traps, `aria-describedby`, scroll strategies and the full menu keyboard contract. What it leaves to us are decisions: which primitive fits which overlay, one surface constant and one position vocabulary shared by all of them, and when *not* to reuse our own abstraction.

The tooltip skips the anchored directive because it is a description, not a control. The drawer skips the dialog service because it has to live in the layout. The menu skips both because `cdk/menu` already owns its overlay, and its rows have to be projected for the keyboard to work.

This is how the overlays are built in [Blouppy Starter](https://starter.blouppy.com/), with the reasoning behind them among its [design system choices](https://docs.starter.blouppy.com/choices/design-system/).

*Thanks for reading! 🙂*
