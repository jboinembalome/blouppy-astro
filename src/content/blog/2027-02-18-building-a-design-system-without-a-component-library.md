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

A component library is the fastest way to get an Angular app on screen. A year later, the look lives in two places: the library's theme and a pile of overrides. A dark theme needs a preset that maps our colours onto the library's variables. A major upgrade renames the classes we were overriding.

The alternative is a design system of our own, on the Angular CDK and CSS tokens. [Blouppy Starter](https://starter.blouppy.com/) took that road: it removed PrimeNG entirely and replaced it with its own package, `@blouppy/ui`.


## What a library really gives us
A library such as PrimeNG or Angular Material gives us three things at once. **Behaviour**: focus, keyboard navigation, positioning, ARIA. **Looks**: a stylesheet and a theming system. **Words**: the default labels of a paginator or an empty table.

Behaviour is the expensive one, and the [Angular CDK](https://angular.dev/api/cdk) provides it without any look: `overlay`, `dialog`, `menu`, `a11y`, `portal`. What we take on is the looks, the words and the wiring.

In the Starter, the looks start with tokens in one CSS file: a palette, then semantic roles such as `--blouppy-card` or `--blouppy-danger-soft`. Radii, spacing and the type scale are not tokens, since Tailwind's scales already express them. How the tokens switch dark mode at runtime is the subject of [Runtime theming in Angular with CSS tokens and Tailwind CSS 4](/blog/2026-06-27-runtime-theming-with-css-tokens-and-tailwind-4/).


## A primitive only reads tokens
Here is the shape of a primitive, a tag (simplified from the library's `ui-tag`). The host is the element, variation is a named input, and every colour is a token:

```ts
@Component({
  selector: 'ui-tag',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '[class]': 'classes()' },
  template: `{{ value() }}<ng-content />`,
})
export class TagComponent {
  /** The label, for a caller with a plain string. Projected content renders too. */
  public readonly value = input<string | number>('');
  /** What the state means. */
  public readonly severity = input<Severity>('primary');

  private static readonly LOOKS: Record<Severity, string> = {
    primary: 'bg-(--blouppy-accent-soft) text-(--blouppy-accent-text)',
    success: 'bg-(--blouppy-success-soft) text-(--blouppy-success-text)',
    danger: 'bg-(--blouppy-danger-soft) text-(--blouppy-danger-text)',
  };

  protected readonly classes = computed(
    () => `inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium ${TagComponent.LOOKS[this.severity()]}`,
  );
}
```

There is no input that accepts a Tailwind class string. It would be an escape hatch from the design language. When the glass container shipped with five of them, only three of its 31 call sites used any, all three to say "no padding". A named input such as `padded` says the same thing in the library's own vocabulary.

Each primitive is its own entry point, `@blouppy/ui/tag`, with no root barrel. The style mirrors `primeng/tag` on purpose: during the migration, each change was one import line swapped for another.


## The library ships its own words
A component that writes "No results" in English is not finished in a French app. So the library ships an `en` and a `fr` catalogue of every label it writes. A component reads its section through `uiText`, with its own inputs on top, and an unbound input falls back to the catalogue:

```ts
// In the select component:
protected readonly text = uiText('select', () => ({ empty: this.emptyLabel() }));

// In the app's providers, once:
provideUiI18n(() => {
  const language = inject(LanguageService).language;

  return { locale: () => language() };
}),
```

`locale` is a function, so a language switch relabels what is already on screen. The library never imports Transloco, and the prerendered sites get English with no setup at all.


## Generic in the library, product in the app
The boundary is written down. Something moves into the library when a second app needs it, or when the design language defines it. Anything that names a product concept stays in the app's `shared/ui/` folder.

`ui-user-avatar` is the typical case. The library's `ui-avatar` already chooses between an image and initials. The app's wrapper adds product knowledge: a user has a display name, the initials come from it, and the name is the accessible label. That keeps the library usable by the landing page and the docs site.

The other rule is a negative one: **a missing primitive is added to `@blouppy/ui`, never pulled from a package**. The day someone installs a slider package, the app has two theming systems again.


## Rules hold where a tool checks them
Code does not say when to use a tag rather than a badge, or that focus lands on cancel in a destructive confirmation. The Starter writes that in a `DESIGN.md` at the root of the repository. Written rules drift, though, so the important ones are checked:

- The playground, a harness app for the library, generates each primitive's API reference from its JSDoc. Its build fails on any `input()`, `model()` or `output()` without one.
- `npm run contrast` renders every component in both schemes and fails below the WCAG floors, 4.5:1 for body text and 3:1 for large text.
- The migration off PrimeNG had dropped, in nine places, a stylesheet rule that made a template work, such as a `flex-shrink: 0` on a footer. Each replaced primitive now lists those rules in the playground, and the build fails on a row that names a specimen the page does not have.

What no tool checks shows the point. The app's own `ui-danger-zone` used to paint its panel with Tailwind's `red-*` scale instead of the danger tokens. Nothing failed on it, so it lasted until a fix in November 2026 moved it onto `--blouppy-danger-soft` and its siblings.


## When a ready-made library is better
Owning the system means owning what the library used to do. Accessibility is our work: `ui-switch` is a `<button role="switch">` with `aria-checked` because we decided so, and each such decision is ours to get wrong.

So a ready-made library is often the better choice. An internal tool where nobody asks for a distinctive look gets there in an afternoon with [Angular Material](/blog/2023-01-01-install-angular-material-in-an-angular-project/). A tree table or a virtualised grid is a project in itself, and PrimeNG ships one. And a design system without an owner decays into the overrides we were trying to escape.

Our own system pays off when the product needs its own look, several front ends must look the same (the Starter has four), and someone keeps the rules and their checks alive.


## References
- [Angular CDK](https://angular.dev/api/cdk) — the behaviour primitives: overlay, dialog, menu, a11y.
- [Tailwind CSS: theme variables](https://tailwindcss.com/docs/theme) — how Tailwind 4 generates utilities from CSS variables.
- [WCAG 2.2: contrast (minimum)](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html) — the 4.5:1 and 3:1 floors.
- [Building overlays on the Angular CDK](/blog/2026-07-21-building-overlays-on-the-angular-cdk/) — how the library's overlays sit on `cdk/dialog` and `cdk/overlay`.
