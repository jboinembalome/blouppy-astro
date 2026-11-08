---
templateKey: 'blog-post'
title: 'Building an Angular design system without a component library'
date: 2027-02-18T09:00:00.000Z
author: Jimmy Boinembalome
authorimage: /img/jimmy.jpg
category: Angular
topic: 'Front end'
illustration: 1
categorycolor: bg-red-100 text-red-800
featuredpost: true
description: >-
  Learn what goes into an in-house Angular design system built on the CDK and CSS tokens, what stays in the app, and when Angular Material or PrimeNG is still the better choice.
tags:
  - Development
  - Angular
  - Tailwind CSS
  - TypeScript
  - Accessibility
---

A component library is the fastest way to get an Angular app on screen. A year later, the look lives in two places: the library's theme and a pile of overrides. A dark theme needs a preset mapping our colours onto the library's variables, and a major upgrade renames the classes we were overriding.

In this article, we will build the alternative, a design system of our own on the Angular CDK and CSS tokens: what goes into the library, what stays in the app, the rules that keep it from drifting, what it costs and when a ready-made library is the better choice. The real example is [Blouppy Starter](https://starter.blouppy.com/), which removed PrimeNG entirely and replaced it with its own package, `@blouppy/ui`.


## What we are replacing
A library such as PrimeNG or Angular Material gives us three things at once: **behaviour** (focus, keyboard navigation, positioning, ARIA), **looks** (a stylesheet and a theming system) and **words** (the default labels of a paginator or an empty table). The expensive one, behaviour, is available without any look in the [Angular CDK](https://angular.dev/api/cdk): `overlay`, `dialog`, `menu`, `a11y`, `portal`. What we take on is the looks, the words and the wiring to the CDK.


## The layers of the library
`@blouppy/ui` is a workspace package in `front/libs/ui/`, consumed as source by the four front-end apps (the application, the landing page, the docs site and the playground). It holds about forty entry points, one folder each, and no root barrel:

```ts
import { ButtonDirective } from '@blouppy/ui/button';
import { TagComponent } from '@blouppy/ui/tag';
import { UiConfirmService } from '@blouppy/ui/confirm';
```

The style mirrors `primeng/button` on purpose: during the migration, each change was one import line swapped for another.

The library is built in four layers:

| Layer | Where | Holds |
| --- | --- | --- |
| Tokens | `src/tokens/tokens.css` | The palette, the neutral scheme, the font, then semantic roles such as `--blouppy-card` or `--blouppy-danger-soft` |
| Tailwind bridge | `src/tokens/tailwind.css` | The `dark` variant and the utilities generated from the tokens |
| Primitives | `src/button/`, `src/tag/`, `src/overlay/`… | Components and directives that only read tokens |
| Strings | `src/i18n/` | An `en` and a `fr` catalogue of every label the library writes |

Radii, spacing and the type scale are absent from the tokens on purpose: Tailwind's scales already express them. The way the tokens switch dark mode and swap the accent at runtime is covered in [Runtime theming in Angular with CSS tokens and Tailwind CSS 4](/blog/2026-06-27-runtime-theming-with-css-tokens-and-tailwind-4/), and how the overlay layer sits on `cdk/dialog` and `cdk/overlay` in [Building overlays on the Angular CDK](/blog/2026-07-21-building-overlays-on-the-angular-cdk/). We will not repeat them here.


## A primitive, minimal version
Here is the smallest useful shape of a primitive: the host is the element, variation is a named input, and every colour is a token.

```ts
import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

export type Severity = 'primary' | 'success' | 'warn' | 'danger';

@Component({
  selector: 'ui-tag',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '[class]': 'classes()' },
  template: `{{ value() }}<ng-content />`,
})
export class TagComponent
{
  /** The label, for a caller with a plain string. Projected content renders too. */
  public readonly value = input<string | number>('');
  /** What the state means. */
  public readonly severity = input<Severity>('primary');

  private static readonly LOOKS: Record<Severity, string> = {
    primary: 'bg-(--blouppy-accent-soft) text-(--blouppy-accent-text)',
    success: 'bg-(--blouppy-success-soft) text-(--blouppy-success-text)',
    warn: 'bg-(--blouppy-warn-soft) text-(--blouppy-warn-text)',
    danger: 'bg-(--blouppy-danger-soft) text-(--blouppy-danger-text)',
  };

  protected readonly classes = computed(() =>
    `inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium ${TagComponent.LOOKS[this.severity()]}`
  );
}
```

There is no input that accepts a Tailwind class string: it would be an escape hatch from the design language. When the glass container shipped with five of them, only three of its 31 call sites used any, all three to say "no padding". A named input such as `padded` says the same thing in the library's own vocabulary.

The other rules are as short: `OnPush` everywhere (the apps are zoneless), handlers the template alone calls are `protected`, and a public signal is exposed through `asReadonly()`.


## The library ships its own words
A component that writes "No results" in English is not finished in a French app. Rather than an English default on every `xxxLabel` input, the library ships catalogues and a small service. A component reads its section through `uiText`, with its own inputs on top:

```ts
protected readonly text = uiText('select', () => ({ empty: this.emptyLabel() }));
```

An input that was never bound reads `undefined`, and `uiText` filters out `undefined` and `''`, so a call site that says nothing gets the catalogue's word. The app says which catalogue is active once, in `app.config.ts`:

```ts
provideUiI18n(() =>
{
  const language = inject(LanguageService).language;

  return { locale: () => language() };
}),
```

`locale` is a function, so the read happens in a reactive context and a language switch relabels what is already on screen. The library never imports Transloco, and the prerendered sites get English with no setup at all.


## JSDoc on every input, enforced
A component library is mostly read through its API. The Starter's playground (`front/playground/`) generates an API Reference table for each primitive from the library's own TypeScript, with a real `ts.Program`, because `input(false)` names no type and its `boolean` only exists in the type checker. The description column is the JSDoc, and `tools/build-api.mjs` throws, failing the build, on any `input()`, `model()` or `output()` without one. The same comment is what the editor shows on hover at the call site, so it is written once. The playground also refuses a catalogue entry whose `sources` do not name a real folder under `front/libs/ui/src`, which is how "a primitive is not done until it is in the playground" stays a rule instead of a wish.


## What stays in the app
The boundary is written down: something moves into the library when **a second app needs it**, or when the design language defines it. Anything that names a product concept stays in the app, in `front/application/src/app/shared/ui/`.

`ui-user-avatar` is a good example. The library's `ui-avatar` already chooses between an image and initials. What the app adds is product knowledge: that a user is identified by a display name, that the initials come from it, and that the name is always the accessible label.

```ts
@Component({
  selector: 'ui-user-avatar',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [AvatarComponent, InitialPipe],
  template: `<ui-avatar [image]="image()" [label]="name() | initial" [size]="size()" [ariaLabel]="name()" />`,
})
export class UserAvatarComponent
{
  /** User display name, used for the initials and as the accessible label. */
  public readonly name = input.required<string>();
  public readonly image = input<string>();
  public readonly size = input<AvatarSize>('normal');
}
```

`ConfirmActionService` does the same over `UiConfirmService`, adding the app's translated "Cancel". The library stays generic, which keeps it usable by the landing page and the docs site.

ESLint holds the app side together: features import compositions from the `app/shared/ui` barrel only, and `shared/` may never import from `features/`.


## A missing primitive goes into the library
The rule that makes the whole thing hold is a negative one: **a missing primitive is added to `@blouppy/ui`, never pulled from a package**. The day someone installs a slider package, the app has two theming systems again.

Adding a primitive means a folder in `front/libs/ui/src`, JSDoc on every input, its strings in both catalogues and a playground entry. That friction is the price of one place where a slider looks like a slider.


## DESIGN.md as the source of truth
Code does not say when to use a tag rather than a badge, or why a tooltip must never be the only place something is written. The Starter keeps that in `DESIGN.md` at the root of the repository; the library's README calls the package "its implementation".

It opens with six principles (the library first, tokens rather than literals, one component in one place, accessible and responsive by default, light and dark as equals), then gives one rule per pattern. For example, a confirmation resolves `true` only on an explicit accept, and focus lands on cancel, never on the destructive button. It ends with an accessibility checklist per screen.

The Starter's instructions for coding assistants say the same thing: read `DESIGN.md` before creating or changing any UI.


## Measuring contrast
`DESIGN.md` sets the floors: 4.5:1 for body text, 3:1 for large text. `npm run contrast` in the playground renders every component in both schemes with Playwright, sweeps every workspace colour ramp, and exits non-zero below a floor. The runtime theming article shows how it reads colours in the browser; the [Playwright gallery](/blog/2026-08-14-visual-review-for-an-angular-app-with-playwright/) is its sibling for layout. The gallery shows what a change looks like, contrast says whether it is legible.


## What it costs
Owning the design system means owning everything a library used to do for us.

- **Accessibility is our work.** The CDK provides focus traps and roving focus, not every semantic choice. `ui-switch` is a `<button role="switch">` with `aria-checked`, and `ui-password`'s reveal control is a real button with `aria-pressed`, because we decided so. Each of those decisions is ours to get wrong.
- **The invariants are invisible.** The migration off PrimeNG ported the templates and, in nine places, dropped a stylesheet rule that made them work: a `min-width: 100%` on a list, a `flex-shrink: 0` on a footer, a `border-collapse: separate` under a sticky header. Each replaced primitive now has a "PrimeNG parity" section in the playground listing the inherited rules, and the build fails on a row that names a specimen the page does not have.
- **Drift starts in the app.** Even with the rules above, the Starter's own `ui-danger-zone` in `shared/ui` still paints with Tailwind's `red-*` scale instead of the danger tokens. Nothing fails on it. Rules only hold where a tool checks them.
- **Time.** A table with sorting and paging, a date range or a rich-text editor is days of work, not an `npm install`.


## When Angular Material or PrimeNG is the better choice
It depends on what the app is for.

- **An internal tool or a back office** where nobody asks for a distinctive look: [installing Angular Material](/blog/2023-01-01-install-angular-material-in-an-angular-project/) gets us there in an afternoon.
- **Heavy data components** such as a tree table, a virtualised grid or a scheduler: PrimeNG ships them, and writing our own is a project in itself.
- **A small team with no one to own the system.** A design system without an owner decays into the overrides we were trying to escape.
- **Accessibility under audit, without the expertise in house.** Angular Material's components are developed and tested by the Angular team; our own are only as good as our own testing.

Our own system pays off when the product needs its own look, several front ends must look the same (the Starter has four), and someone will keep `DESIGN.md`, the playground and the checks alive.


## Conclusion
A design system of our own is less code than it sounds, because the Angular CDK already solves the hard behaviour. We write tokens in CSS, small primitives that only read them, catalogues for their words and JSDoc for their API. What keeps it from drifting is a written boundary (generic in the library, product knowledge in the app), one rule (a missing primitive goes into the library), `DESIGN.md`, and tools that fail the build. The cost is real: accessibility, maintenance and time are ours now.


## References
- [Angular CDK](https://angular.dev/api/cdk) — the behaviour primitives: overlay, dialog, menu, a11y.
- [Tailwind CSS: theme variables](https://tailwindcss.com/docs/theme) — how Tailwind 4 generates utilities from CSS variables.
- [WCAG 2.2: contrast (minimum)](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html) — the 4.5:1 and 3:1 floors.
- [WAI-ARIA Authoring Practices: switch pattern](https://www.w3.org/WAI/ARIA/apg/patterns/switch/) — what `role="switch"` promises.
- [Angular Material](https://material.angular.dev/) — the official component library, when a ready-made one fits.
- [PrimeNG](https://primeng.org/) — a broad component library with data-heavy components.
