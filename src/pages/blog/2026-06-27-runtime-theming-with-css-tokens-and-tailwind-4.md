---
templateKey: 'blog-post'
title: 'Runtime theming in Angular with CSS tokens and Tailwind CSS 4'
date: 2026-06-27T09:00:00.000Z
updated: 2026-11-07T09:00:00.000Z
author: Jimmy Boinembalome
authorimage: /img/jimmy.jpg
category: Angular
topic: 'Front end'
illustration: 1
categorycolor: bg-red-100 text-red-800
featuredpost: true
featuredimage: /img/runtime-theming-with-css-tokens-and-tailwind-4.jpg
description: >-
  Learn how to change the accent colour and switch dark mode at runtime in an Angular application, with CSS custom properties, Tailwind CSS 4 and a contrast check that keeps every colour legible.
tags:
  - Development
  - Angular
  - Tailwind CSS
  - CSS
  - Accessibility
---

Sooner or later, a SaaS application wants to wear a colour that is not its own, such as the colour of the workspace you are in, and a dark mode that follows the user or the operating system. A build-time theme cannot help: the colour is only known once a page is open.

A colour picked at runtime is also a colour nobody designed for. White text on `emerald-500` reads at about 2.5:1, half of what [WCAG AA](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html) asks for, and the build will not tell us.

In this article, we will build runtime theming on **CSS custom properties**, plug them into **Tailwind CSS 4**, switch the accent and the dark scheme from two **Angular** services, and measure contrast in a real browser.


## Two layers of tokens
Everything starts with one file of [CSS custom properties](https://developer.mozilla.org/docs/Web/CSS/Using_CSS_custom_properties): **primitives** say what the colours are, **roles** say what they are for. Here is an excerpt of `tokens.css`:

```css
:root {
  color-scheme: light;

  /* Brand palette (indigo): eleven steps, replaced at runtime. */
  --blouppy-primary-50: #f5f5fc;
  /* … 100 to 900 … */
  --blouppy-primary-500: #676dcf;
  --blouppy-primary-600: #5052a7;
  --blouppy-primary-950: #0b0d1f;

  /* A solid primary surface, and the text that sits on it. */
  --blouppy-primary-fill: var(--blouppy-primary-fill-light, var(--blouppy-primary-500));
  --blouppy-primary-fill-hover: var(--blouppy-primary-fill-hover-light, var(--blouppy-primary-600));
  --blouppy-primary-contrast: var(--blouppy-primary-contrast-light, var(--blouppy-surface-0));

  /* Neutrals (zinc) and semantic roles. */
  --blouppy-surface-0: #ffffff;
  --blouppy-bg: var(--blouppy-surface-0);
  --blouppy-accent-soft: var(--blouppy-primary-100);
  --blouppy-accent-text: var(--blouppy-accent-text-light, var(--blouppy-primary-600));
  --blouppy-focus-ring-color: var(--blouppy-accent-text);
}
```

- The eleven `--blouppy-primary-*` steps are the only place the accent is written as a value.
- `--blouppy-primary-fill` is a **role**: which step reads as "filled" depends on the scheme and the hue.
- The `-light` fallbacks are the runtime seam. Unset, the brand indigo stands, even on a prerendered page with no JavaScript.

Components only read the role layer. Here is the primary variant of the button directive:

```typescript
primary: 'border-transparent bg-(--blouppy-primary-fill) text-(--blouppy-primary-contrast) hover:bg-(--blouppy-primary-fill-hover)',
```

`bg-(--my-var)` is Tailwind 4's shorthand for `bg-[var(--my-var)]`. The button does not know which colour it is.


## The dark scheme swaps the neutrals
The dark scheme is a `.dark` block in the same file. It swaps the neutral family and sets the roles again:

```css
.dark {
  color-scheme: dark;

  --blouppy-surface-200: var(--color-slate-200);
  --blouppy-surface-950: var(--color-slate-950);

  --blouppy-primary-fill: var(--blouppy-primary-400);
  --blouppy-primary-fill-hover: var(--blouppy-primary-300);
  --blouppy-primary-contrast: var(--blouppy-surface-950);

  --blouppy-bg: var(--blouppy-surface-950);
  --blouppy-accent-soft: color-mix(in srgb, var(--blouppy-primary-500) 16%, transparent);
  --blouppy-accent-text: var(--blouppy-primary-300);
}

html {
  background-color: var(--blouppy-bg);
}
```

- [`color-scheme: dark`](https://developer.mozilla.org/docs/Web/CSS/color-scheme) makes scrollbars and native controls follow.
- The fill moves **up** to the 400 with near-black text, because the 500 only reaches 4.48:1 on a dark page.
- The soft accent becomes a 16% wash of the 500 with [`color-mix()`](https://developer.mozilla.org/docs/Web/CSS/color_value/color-mix): an opaque 100-step pastel glows on a near-black page.
- The `html` rule paints the root: translucent panels over an unpainted page make a grey theme, not a dark one.


## Teaching Tailwind 4 about the tokens
Tailwind 4 is configured in CSS, with [`@theme`](https://tailwindcss.com/docs/theme). A second file maps the tokens to utilities without repeating any value:

```css
@custom-variant dark (&:where(.dark, .dark *));

@theme {
  --font-sans: var(--blouppy-font-sans);

  --color-primary-50: var(--blouppy-primary-50);
  /* … 100 to 950 … */
  --color-surface-0: var(--blouppy-surface-0);
  /* … */
}
```

The application imports the three files in this order:

```css
@import 'tailwindcss';
@import '@blouppy/ui/tokens.css';
@import '@blouppy/ui/tailwind.css';
```

- [`@custom-variant dark`](https://tailwindcss.com/docs/dark-mode) replaces the default `prefers-color-scheme` media query with a class, because the scheme is the user's choice.
- Each `--color-primary-*` maps to a `var()`, so `bg-primary-500` resolves through our token at runtime, with no rebuild.
- The roles are deliberately **not** mapped to utilities: components read them straight from the token.


## Switching dark mode
`ThemeService` holds the scheme (`'light' | 'dark' | 'system'`) in a [signal](https://angular.dev/guide/signals) and applies it to the root element:

```typescript
private apply(): void {
  const dark = this.mode() === 'dark' || (this.mode() === 'system' && (this._mediaQueryList?.matches ?? false));

  this._document.documentElement.classList.toggle('dark', dark);
  this.isDark.set(dark);
}
```

`system` is resolved against `matchMedia('(prefers-color-scheme: dark)')`, and again on its `change` event. Every browser API sits behind an `isPlatformBrowser` check, so the service is safe during prerendering. `setMode()` saves the choice to `localStorage` inside a `try`/`catch`, because a privacy mode that blocks writes must not stop the theme from applying, under a key each app provides through an `InjectionToken`.

> **_Note:_**  A root-provided service is only constructed on first injection, so the root component injects it for that side effect.


## Swapping the accent at runtime
`PrimaryRampService` writes the eleven steps, plus four role choices, on the document element:

```typescript
private write(ramp: PrimaryRamp): void {
  const style = this._document.documentElement.style;

  for (const step of STEP_PROPERTIES) {
    style.setProperty(`--blouppy-primary-${step}`, ramp.steps[step]);
  }

  // Hover moves the fill away from the text sitting on it, never towards it.
  const fillHover = ramp.contrast === 'surface' ? ramp.fill + 100 : ramp.fill - 100;

  style.setProperty('--blouppy-primary-fill-light', `var(--blouppy-primary-${ramp.fill})`);
  style.setProperty('--blouppy-primary-fill-hover-light', `var(--blouppy-primary-${fillHover})`);
  style.setProperty('--blouppy-primary-contrast-light', ramp.contrast === 'surface' ? 'var(--blouppy-surface-0)' : 'var(--blouppy-primary-950)');
  style.setProperty('--blouppy-accent-text-light', `var(--blouppy-primary-${ramp.accentText})`);
}
```

That list of properties is the **whole** runtime contract: the soft tint, the focus ring and the `primary-*` utilities derive from it in CSS. Three decisions hide in these lines:
- **The document element.** The roles are declared on `:root`, so their `var()` substitution happens there. A ramp written lower in the tree moves the steps and leaves `--blouppy-primary-fill` behind: a button in the old colour next to a tag in the new one.
- **References, not values**, so the eleven steps stay the only place a colour lives.
- **Only the light scheme's choices**, in the `-light` fallbacks that only `:root` reads. The `.dark` block sets the roles directly, so it still wins.

The ramps are a TypeScript table, `PRIMARY_RAMPS`, with Tailwind's [`oklch()`](https://developer.mozilla.org/docs/Web/CSS/color_value/oklch) values copied in: Tailwind only emits `--color-emerald-500` when a build uses an emerald utility, so referencing it could resolve to nothing. The service restores the saved ramp on start, so a reload does not flash the brand indigo, and the app shell calls `setRamp()` inside a workspace and `reset()` outside one.


## A fill is not always the 500
This is where contrast comes in. Each ramp records three measured light-scheme choices next to its steps:

```typescript
emerald: {
  steps: {
    50: 'oklch(97.9% 0.021 166.113)',
    // … 100 to 900 …
    950: 'oklch(26.2% 0.051 172.552)',
  },
  // fill 6.14:1, accent text 4.72:1
  fill: 500,
  contrast: '950',
  accentText: 700,
},
```

`fill` is the step a solid fill uses (500 or 600), `contrast` the text on it (white or the ramp's own 950), `accentText` the step text takes on the soft tint. White on `emerald-500` fails, but darkening every bright hue would turn it into mud, so emerald keeps its 500 and takes its own 950 as text, at 6.14:1. Of the twenty-two ramps, nine do the same, seven drop the fill to the 600 and keep white, and six carry white at the 500.

Hover follows from that choice: a ramp carrying dark text gets **lighter** on hover (the `fillHover` line above), because darkening a `sky-500` to its 600 under near-black text would drop it from 4.5:1 to 3.45:1. The dark scheme needs no table: a 400 fill and a 300 accent clear the floor for all twenty-two ramps.


## What stays neutral: the surface
The colour never repaints the page. An accent marks *which* workspace you are in; the neutral pair (zinc in light, slate in dark) is a scheme decision, not a brand one. And every role is measured against the surface behind it, so a themeable surface would turn 22 × 2 contrast combinations into 22 × 22 × 2.


## Measuring contrast in a browser
Those ratios would rot without a check. The design-system playground has `npm run contrast`, a [Playwright](https://playwright.dev/) script that renders every component in both schemes and sweeps all twenty-two ramps. It measures in the browser, not over the token file, because the tints are `color-mix(… transparent)` over whatever is behind them. The theme is set before the app boots with [`addInitScript`](https://playwright.dev/docs/api/class-page#page-add-init-script), by seeding the `localStorage` keys the two services read:

```javascript
await page.addInitScript(
  entries => {
    for (const [key, value] of entries) {
      localStorage.setItem(key, value);
    }
  },
  [
    ['blouppy-playground-theme', scheme],
    ['blouppy-playground-ramp', ramp],
  ]
);
await page.goto(`${base}/${route}`, { waitUntil: 'networkidle' });
```

Inside the page, each element's text colour is compared with the colour actually behind it. The computed colour is painted onto a 1×1 canvas and read back, so the browser does the `oklch()` conversion, and a translucent fill is flattened onto its first opaque ancestor. The floor is 4.5:1 for body text and 3:1 for large text (24px, or 18.66px bold); anything below fails the run with the scheme, the ramp and the element. The ramp names are read from `ramps.ts`, so a ramp added there is measured here.


## Conclusion
Runtime theming needs no theming library. Two layers of CSS custom properties, a `.dark` class on the root element and Tailwind 4's `@theme` pointing at `var()`s are enough: change eleven properties on the document element and everything follows, without a rebuild. Keeping it legible takes measured role choices per colour, a decision on what stays neutral, and a check that renders the real page for every colour in both schemes.

This is how runtime theming is built in [Blouppy Starter](https://starter.blouppy.com/), where a workspace's colour repaints the application's accent.


## References
- [Theme variables](https://tailwindcss.com/docs/theme) (Tailwind CSS) — `@theme` and how theme variables generate utilities.
- [Dark mode](https://tailwindcss.com/docs/dark-mode) (Tailwind CSS) — overriding the `dark` variant with `@custom-variant`.
- [Using CSS custom properties](https://developer.mozilla.org/docs/Web/CSS/Using_CSS_custom_properties) (MDN) — declaration, inheritance and `var()` fallbacks.
- [`color-scheme`](https://developer.mozilla.org/docs/Web/CSS/color-scheme), [`color-mix()`](https://developer.mozilla.org/docs/Web/CSS/color_value/color-mix) and [`oklch()`](https://developer.mozilla.org/docs/Web/CSS/color_value/oklch) (MDN) — the three CSS features the tokens rely on.
- [Understanding SC 1.4.3: Contrast (Minimum)](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html) (W3C) — the 4.5:1 and 3:1 floors.
- [`page.addInitScript`](https://playwright.dev/docs/api/class-page#page-add-init-script) (Playwright) — seeding storage before the app boots.
- [Theme](https://docs.starter.blouppy.com/guides/customize/theme) (Blouppy Starter docs) — how to change the Starter's palette and tokens.
