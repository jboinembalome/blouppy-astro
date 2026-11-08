---
templateKey: 'blog-post'
title: 'Tailwind CSS 3 to 4: what the upgrade tool does not catch'
date: 2026-11-08T09:00:00.000Z
author: Jimmy Boinembalome
authorimage: /img/jimmy.jpg
category: CSS
topic: 'Front end'
illustration: 3
categorycolor: bg-blue-100 text-blue-800
featuredpost: true
description: >-
  Twelve differences found by comparing a site pixel by pixel before and after moving to Tailwind CSS 4: borders, line heights, cascade layers, table cells, stacking, colours.
tags:
  - Development
  - CSS
  - Tailwind CSS
  - Testing
---

Tailwind CSS 4 comes with an upgrade tool that rewrites the configuration and renames classes. On this blog, it ran without an error, the build passed, and most pages looked the same. Then a screenshot diff showed that **every page** was a few pixels shorter, and a browser test showed that the search results could no longer be clicked.

The [upgrade guide](https://tailwindcss.com/docs/upgrade-guide) lists the breaking changes, but a list does not tell you which ones hit your pages. In this article, we will go through the twelve differences we measured while moving this site from Tailwind 3.4 to 4.3, how we found them, and how each was fixed so the site stayed identical, pixel for pixel.


## How we found them
The method is the one we used to [move this blog from Gatsby to Astro](/blog/2026-11-07-moving-a-blog-from-gatsby-to-astro-without-a-regression/): build before and after, then compare.

- **Screenshots** of every page and every article, in both themes and at three widths, compared pixel by pixel. They tell you that something moved.
- **Element geometry**: for each element, its bounding box and a few computed styles, collected on both builds and compared in document order. It tells you which element moved first, and why.
- **Browser tests** for states a screenshot of a page at rest never shows: an open dialog, a focused field, a menu.

```js
const rects = await page.evaluate(() =>
  [...document.querySelectorAll("main *")].map((element) => {
    const box = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return {
      tag: element.tagName,
      box: [box.x, box.y, box.width, box.height].map((v) => Math.round(v * 10) / 10).join(","),
      style: ["font-size", "line-height", "padding-top", "border-top-color"].map((p) => style.getPropertyValue(p)).join("|"),
    };
  }),
);
```

The first element whose box differs is almost always the cause; everything after it only follows.


## What the upgrade tool did
`npx @tailwindcss/upgrade` did the mechanical part well: `shadow-sm` became `shadow-xs`, `flex-shrink-0` became `shrink-0`, `aspect-[4/5]` became `aspect-4/5`. Two things needed care:

- It **rewrote the Markdown articles too**: their code samples contain Tailwind classes, which are examples, not markup. Revert the content folder after running it.
- It turned every class of the global stylesheet into a separate `@utility`, across several new files. We kept the original structure instead, with Tailwind 4 loading the existing configuration:

```css
/* src/styles/site.css */
@import "tailwindcss";
@config "../../tailwind.config.cjs";

@import "./tokens.css";
@import "./global.css";

@custom-variant dark (&:where(.dark, .dark *));
```

The site also used Sass, only for nesting. Tailwind 4 [is not designed to run with Sass](https://tailwindcss.com/docs/upgrade-guide#using-sass-less-and-stylus) and CSS has native nesting now, so the files became plain CSS.


## 1. Borders default to the text colour
**Documented.** In v3, a `border` without a colour was `gray-200`; in v4 it is `currentColor`. The guide suggests a compatibility rule reading `var(--color-gray-200, currentcolor)`. With a JavaScript config that replaces the theme's colours, that variable does not exist, so the fallback quietly gives the text colour again. Write the value:

```css
@layer base {
  *, ::after, ::before, ::backdrop, ::file-selector-button {
    border-color: #e5e7eb;
  }
}
```

## 2. The palette is in oklch
`tailwindcss/colors` now returns oklch colours, close to the v3 hex values but not equal. The footer's `bg-zinc-950` became `oklch(0.141 0.005 285.823)`. A site designed with the v3 palette can keep it: we copied the hex values of the colours we use into `tailwind.v3-theme.cjs`.

## 3. Line heights are unitless
In v3, `text-sm` set `line-height: 1.25rem`, a length. In v4, it sets a ratio. A child that inherits the line height without setting a font size now gets a different value: an uppercase footer heading went from 20px to 19.29px, and every page lost two pixels. Keeping v3's type scale in the configuration restores the lengths:

```js
fontSize: {
  sm: ["0.875rem", { lineHeight: "1.25rem" }],
  // ...the rest of v3's scale
},
```

## 4. `leading-*` now beats a responsive `text-*`
**Not in the guide.** An article title had `leading-tight sm:text-4xl`. In v3, `sm:text-4xl` set both the size and its line height, and came later in the stylesheet, so from `sm` up the line height was 2.5rem. In v4, a font-size utility reads `var(--tw-leading, ...)`, and `leading-tight` sets that variable: it wins at every width, and the title grew by 54 pixels. Write the intent explicitly:

```html
<h1 class="text-3xl leading-tight sm:text-4xl sm:leading-10">
```

## 5. `space-y-*` puts the margin on the other side
**Documented.** `space-y-1` used to add `margin-top` to every child but the first, with a selector specific enough to override a child's `mt-3`. In v4, it adds `margin-bottom` to every child but the last. The `mt-3` on the last link of the mobile menu, ignored for years, suddenly applied. Removing it restored the menu.

## 6. Preflight resets table cells
**Not in the guide**, except for `<dialog>`. Tailwind 4's preflight sets `padding: 0` on every element. Tailwind 3 left table cells the browser's 1px, and the typography plugin only sets the other sides of a `th`. Each table's header row was one pixel shorter:

```css
@layer base {
  th, td { padding: 1px; }
}
```

## 7. Cascade layers change who wins
Tailwind 4 uses native [cascade layers](https://developer.mozilla.org/docs/Web/CSS/@layer). Any CSS outside a layer now beats every layered rule, whatever its specificity. Our global `:focus-visible` outline, outside any layer, overrode the forms plugin's `[type=search]:focus` rule, which used to win on specificity: the search field got a focus outline it never had. Moving the global base rules into `@layer base` restored the v3 behaviour, where specificity decides:

```css
@layer base {
  :focus-visible {
    outline: 2px solid var(--blouppy-focus-ring-color);
    outline-offset: 2px;
  }
}
```

## 8. `transform` no longer lifts an element
This one broke a feature. The search dialog has a full-screen backdrop (`fixed inset-0`), then a panel with the classes `transform scale-100`. In v3, `transform` set a real `transform` value, which creates a [stacking context](https://developer.mozilla.org/docs/Web/CSS/CSS_positioned_layout/Stacking_context) and painted the panel above the backdrop. In v4, scaling uses the [individual `scale` property](https://tailwindcss.com/docs/upgrade-guide#individual-transform-properties) and `transform` alone resolves to nothing: the backdrop covered the panel and caught every click. No screenshot of a page at rest shows it. A browser test that clicks a search result does. The fix is one class:

```tsx
<Dialog.Panel className="relative mx-auto max-w-xl transform ...">
```

## 9. Opacity modifiers mix in oklab
`bg-white/5` is now `color-mix(in oklab, ...)`. On the code blocks' copy button, that was one or two units away from v3's `rgb(255 255 255 / 0.05)`. Invisible, but it made every article screenshot differ. An arbitrary value keeps the exact colour:

```css
@apply bg-[rgb(255_255_255/0.05)] hover:bg-[rgb(255_255_255/0.1)];
```

## 10. Buttons and placeholders
**Documented.** Buttons use the default cursor, and placeholders are the text colour at 50% opacity. Two lines in the base layer give back the pointer and v3's grey `#9ca3af`.

## 11. `transition-colors` also animates the outline
**Documented.** The focus outline now fades in over 150ms instead of appearing at once. We kept it.

## 12. `hover:` only applies where hovering exists
**Documented.** On touch screens, hover styles no longer stick after a tap. An improvement, which we kept as well.


## The result
After these fixes, the 60 page screenshots, the open dialog, the menus, keyboard focus and the 88 article screenshots were identical to the Tailwind 3 build, pixel for pixel, and the position and size of every element in the 44 articles matched. The site now runs Tailwind 4 through its Vite plugin, without Sass or a PostCSS configuration, and browser tests on every pull request click through the states a screenshot misses, starting with the search dialog.


## Conclusion
The upgrade tool takes care of renames. What it cannot know is how your pages relied on v3's defaults: inherited line heights, a margin that a more specific selector used to override, a stacking context created as a side effect. Half of the differences we hit are in the guide and half are not. Measuring before and after is what makes the difference between "it looks fine" and "it is the same".


## References
- [Tailwind CSS upgrade guide](https://tailwindcss.com/docs/upgrade-guide) — the documented breaking changes.
- [Default border color](https://tailwindcss.com/docs/upgrade-guide#default-border-color), [space-between selector](https://tailwindcss.com/docs/upgrade-guide#space-between-selector) and [preflight changes](https://tailwindcss.com/docs/upgrade-guide#preflight-changes) — items 1, 5 and 10.
- [Individual transform properties](https://tailwindcss.com/docs/upgrade-guide#individual-transform-properties) — item 8.
- [Transitioning outline-color](https://tailwindcss.com/docs/upgrade-guide#transitioning-outline-color) and [hover styles on mobile](https://tailwindcss.com/docs/upgrade-guide#hover-styles-on-mobile) — items 11 and 12.
- [Functions and directives](https://tailwindcss.com/docs/functions-and-directives) — `@config`, `@custom-variant`, `@utility`.
- [@layer](https://developer.mozilla.org/docs/Web/CSS/@layer) — cascade layers and unlayered styles.
- [Stacking context](https://developer.mozilla.org/docs/Web/CSS/CSS_positioned_layout/Stacking_context) — what creates one.
- [color-mix()](https://developer.mozilla.org/docs/Web/CSS/color_value/color-mix) — how the opacity modifiers are computed.
