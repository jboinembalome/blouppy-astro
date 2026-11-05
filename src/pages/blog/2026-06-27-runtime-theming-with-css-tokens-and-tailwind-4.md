---
templateKey: 'blog-post'
title: 'Runtime theming in Angular with CSS tokens and Tailwind CSS 4'
date: 2026-06-27T09:00:00.000Z
author: Jimmy Boinembalome
authorimage: /img/jimmy.jpg
category: Angular
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

Sooner or later, a SaaS application wants to wear a colour that is not its own, such as the colour of the workspace you are in. And the user wants a dark mode, or the operating system's. A build-time theme does not help here: the colour is only known once the user has signed in and opened a page.

There is a quieter problem too: a colour picked at runtime is a colour nobody designed for. White text on `emerald-500` reads at about 2.5:1, half of what WCAG AA asks for, and the build will not tell us.

In this article, we will build runtime theming on **CSS custom properties** (design tokens), plug them into **Tailwind CSS 4** with `@theme`, switch the accent and the dark scheme from two small **Angular** services, and measure contrast in a real browser so the result stays legible.


## Two layers of tokens
Everything starts with one CSS file. It declares two kinds of tokens: **primitives**, which say what the colours are, and **roles**, which say what they are for. Here is an excerpt of `tokens.css`:

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

  /* Neutrals: zinc in light mode, slate in dark. */
  --blouppy-surface-0: #ffffff;
  --blouppy-surface-200: var(--color-zinc-200);

  /* Semantic roles. */
  --blouppy-bg: var(--blouppy-surface-0);
  --blouppy-border: var(--blouppy-surface-200);
  --blouppy-accent-soft: var(--blouppy-primary-100);
  --blouppy-accent-text: var(--blouppy-accent-text-light, var(--blouppy-primary-600));
  --blouppy-focus-ring-color: var(--blouppy-accent-text);
}
```

A few things are worth noticing:
- The eleven `--blouppy-primary-*` steps are the only place the accent is written as a value.
- `--blouppy-primary-fill` is a **role**, not a step. Which step reads as "filled" depends on the scheme and the hue.
- The `-light` fallbacks (`--blouppy-primary-fill-light`, …) are the runtime seam. Unset, the brand indigo stands, even on a prerendered page with no JavaScript.
- The focus ring is the accent **text** step, not the 500: on a white page, the 500 of a bright hue is a ring nobody can see.

Components only read the role layer. Here is the primary variant of the button directive:

```typescript
primary: 'border-transparent bg-(--blouppy-primary-fill) text-(--blouppy-primary-contrast) hover:bg-(--blouppy-primary-fill-hover)',
```

`bg-(--my-var)` is Tailwind 4's shorthand for `bg-[var(--my-var)]`. The button does not know which colour it is, and that is the point.


## The dark scheme swaps the neutrals
The dark scheme is a `.dark` block in the same file. It swaps the neutral family and spells out the roles again:

```css
.dark {
  color-scheme: dark;

  --blouppy-surface-200: var(--color-slate-200);
  --blouppy-surface-950: var(--color-slate-950);

  --blouppy-primary-fill: var(--blouppy-primary-400);
  --blouppy-primary-fill-hover: var(--blouppy-primary-300);
  --blouppy-primary-contrast: var(--blouppy-surface-950);

  --blouppy-bg: var(--blouppy-surface-950);
  --blouppy-border: var(--blouppy-surface-800);
  --blouppy-heading: var(--blouppy-surface-100);
  --blouppy-accent-soft: color-mix(in srgb, var(--blouppy-primary-500) 16%, transparent);
  --blouppy-accent-text: var(--blouppy-primary-300);
}

html {
  background-color: var(--blouppy-bg);
}
```

Here is why it looks like this:
- `color-scheme: dark` tells the browser, so scrollbars and native controls follow.
- Dark mode is not a darker light mode. The fill moves **up** to the 400 and the text on it becomes near-black, because the 500 only reaches 4.48:1 on a dark page.
- A 100-step tint is an opaque pastel that glows on a near-black page, so the soft accent becomes a 16% wash of the 500 with `color-mix()`.
- The last rule paints the root element: a dark theme of translucent panels over an unpainted (white) page is a grey one.


## Teaching Tailwind 4 about the tokens
Tailwind 4 is configured in CSS, with `@theme`. A second file only teaches Tailwind how to generate utilities from the tokens, without repeating any value:

```css
@custom-variant dark (&:where(.dark, .dark *));

@theme {
  --font-sans: var(--blouppy-font-sans);

  --color-primary-50: var(--blouppy-primary-50);
  --color-primary-500: var(--blouppy-primary-500);
  --color-primary-950: var(--blouppy-primary-950);

  --color-surface-0: var(--blouppy-surface-0);
  --color-surface-200: var(--blouppy-surface-200);
}
```

And the application imports the three, in this order:

```css
@import 'tailwindcss';
@import '@blouppy/ui/tokens.css';
@import '@blouppy/ui/tailwind.css';
```

- `@custom-variant dark` replaces Tailwind's default `prefers-color-scheme` media query with a class, because the scheme is the user's choice.
- Each `--color-primary-*` maps to a `var()`, so `bg-primary-500` resolves through our token at runtime. Change the token and every utility follows, with no rebuild.
- The roles are deliberately **not** mapped to utilities: a role is not a step, and they are read straight from the token.


## Switching dark mode
Let's look at `ThemeService`, which owns the scheme (`'light' | 'dark' | 'system'`). Trimmed, it looks like this:

```typescript
@Injectable({ providedIn: 'root' })
export class ThemeService {
  private readonly _document = inject(DOCUMENT);
  private readonly _isBrowser = isPlatformBrowser(inject(PLATFORM_ID));
  private readonly _storageKey = inject(BLOUPPY_THEME_STORAGE_KEY);
  private _mediaQueryList: MediaQueryList | null = null;

  public readonly mode = signal<ThemeMode>('system');
  public readonly isDark = signal<boolean>(false);

  constructor() {
    if (!this._isBrowser) {
      return;
    }

    this._mediaQueryList = window.matchMedia('(prefers-color-scheme: dark)');
    this._mediaQueryList.addEventListener('change', () => {
      if (this.mode() === 'system') {
        this.apply();
      }
    });

    this.mode.set(this.read() ?? 'system');
    this.apply();
  }

  private apply(): void {
    const dark = this.mode() === 'dark' || (this.mode() === 'system' && (this._mediaQueryList?.matches ?? false));

    this._document.documentElement.classList.toggle('dark', dark);
    this.isDark.set(dark);
  }
}
```

- `system` is resolved against the operating system, and re-resolved when it changes.
- `setMode()` (not shown) saves the choice to `localStorage` inside a `try`/`catch`: a privacy mode that blocks writes must not stop the theme from being applied.
- The storage key is an `InjectionToken`, so each app provides its own: a visitor's choice on the marketing site should not re-theme the product.

> **_Note:_**  A root-provided service is only constructed on first injection, so the root component injects it just for that side effect.


## Swapping the accent at runtime
Now the accent. `PrimaryRampService` writes the eleven steps, plus four role choices, on the document element:

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

That list of properties is the **whole** runtime contract: the soft tint, the focus ring and the Tailwind `primary-*` utilities are derived from it in CSS. The tokens are the contract, not the service, so anything that sets those properties themes the app.

Three decisions hide in these lines:
- **The document element, not "some element high up".** The roles are declared on `:root`, so their `var()` substitution happens there. A ramp written lower in the tree moves the eleven steps and leaves `--blouppy-primary-fill` behind: a button in the old colour next to a tag in the new one.
- **References, not values.** The roles are written as `var(--blouppy-primary-600)`, so the eleven steps stay the only place a colour lives.
- **Only the light scheme's choices.** They go into the `-light` fallbacks, which only the `:root` rule reads. In dark mode, the `.dark` block sets the roles directly, so it still wins.

The constructor restores the saved ramp, so a reload does not flash the brand indigo, and `reset()` falls back to `tokens.css`. The ramps themselves are a TypeScript table, `PRIMARY_RAMPS`, with Tailwind's `oklch()` values copied: Tailwind only emits `--color-emerald-500` when a build uses an emerald utility, so referencing it could resolve to nothing.

## A fill is not always the 500
This is where contrast comes in. Each ramp records three measured light-scheme choices alongside its steps:

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

- `fill`: the step a solid fill uses, the 500 or the 600.
- `contrast`: the text on it, white or the ramp's own 950.
- `accentText`: the step text takes on the soft tint.

White on `emerald-500` fails, but darkening every bright hue would turn it into mud. So emerald keeps its 500 and takes its own 950 as text, at 6.14:1. According to the design notes, nine bright ramps do the same, seven drop the fill to the 600 and keep white, and the remaining six (indigo and the five neutrals) carry white at the 500 already.

Hover follows from that choice: a ramp carrying dark text gets **lighter** on hover. Darkening a `sky-500` to its 600 under near-black text would cost a full point, from 4.5:1 down to 3.45:1. That is the `fillHover` line we saw above. 😉

The dark scheme needs no table: a 400 fill under near-black text and a 300 on the tinted wash clear the floor for all twenty-two ramps.

Then, in the application, the shell watches the current workspace's colour and applies it:

```typescript
toObservable(this._workspaceService.currentColour, { injector: this._injector })
  .pipe(takeUntilDestroyed(this._destroyRef))
  .subscribe(colour => {
    const ramp = toPrimaryRampName(colour);

    if (ramp) {
      this._primaryRamp.setRamp(ramp);
    } else {
      this._primaryRamp.reset();
    }
  });
```

`toPrimaryRampName()` downcases the back end's `Colour` and returns `null` for anything it does not know, so outside a workspace the default ramp is back.


## What we chose not to theme: the surface
It is tempting to let the colour repaint the page too. The code base this comes from decided not to, for four reasons:
- **An accent is not a repaint.** The colour marks *which* workspace you are in, from a tag or a button. Recolouring the page beneath it says something the product does not mean.
- **The neutral pair is a scheme decision, not a brand one.** Zinc in light, slate in dark, chosen together so the two schemes feel like one product.
- **The contrast matrix multiplies.** Every role is measured against the surface behind it. A themeable surface turns 22 × 2 combinations into 22 × 22 × 2, and the soft tint is a `color-mix()` over whatever is behind it, so the numbers genuinely change.
- **Nobody asked for it.**

Reversing it would be cheap in code, since the surface is already a token family. The contrast work is what would not be.


## Measuring contrast in a browser
Those ratios would rot quietly without a check. The design-system playground has `npm run contrast`, a Playwright script that renders every component in both schemes, then sweeps all twenty-two ramps across a theming page. It measures in the browser rather than over the token file, because the tints are `color-mix(… transparent)` over whatever is behind them and Tailwind emits `oklch()`.

The theme is set before the app boots, by seeding the same `localStorage` keys the two services read:

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

Then, inside the page, each element's text colour is compared with the colour actually behind it:
- The computed colour is painted onto a 1×1 canvas and read back, so the browser does the `oklch()` conversion.
- A translucent fill is walked up to the first opaque ancestor and the layers are flattened, because that composite is what the eye compares the text against.
- The floor is 4.5:1 for body text and 3:1 for large text (24px, or 18.66px bold), as `DESIGN.md` §2.4 sets. Anything below fails the run with the scheme, the ramp and the element.

The ramp names are read out of `ramps.ts` itself, so a ramp added there is a ramp measured here.


## Conclusion
Runtime theming needs no theming library. Two layers of CSS custom properties (primitives and roles), a `.dark` class on the root element and Tailwind 4's `@theme` pointing at `var()`s are enough: change eleven properties on the document element and every component and utility follows, without a rebuild.

The harder part is keeping it legible. A runtime colour needs measured role choices (which step fills, what text sits on it, which way hover goes), a deliberate decision on what stays neutral, and a check that renders the real page in both schemes for every colour.

This is how runtime theming is built in [Blouppy Starter](https://starter.blouppy.com/), where a workspace's colour repaints the application's accent. The [design system's documentation](https://docs.starter.blouppy.com/choices/design-system/) explains why it owns its tokens and components.

*Thanks for reading! 🙂*
