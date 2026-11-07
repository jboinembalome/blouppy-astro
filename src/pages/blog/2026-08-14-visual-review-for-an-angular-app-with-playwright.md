---
templateKey: 'blog-post'
title: 'Visual review for an Angular app: a Playwright gallery of every page'
date: 2026-08-14T09:00:00.000Z
author: Jimmy Boinembalome
authorimage: /img/jimmy.jpg
category: Angular
topic: 'Testing'
illustration: 3
categorycolor: bg-red-100 text-red-800
featuredpost: true
featuredimage: /img/visual-review-for-an-angular-app-with-playwright.jpg
description: >-
  Learn how to build a Playwright gallery that photographs every route of an Angular application, in both themes and three widths, so that a human can review the layout that unit tests never see.
tags:
  - Development
  - Angular
  - Playwright
  - Testing
  - CSS
---

Our unit specs are green. Every component renders, every signal updates, every button emits. And yet the dark theme ships washed out, or a page silently stops scrolling inside the application shell. How? Because the specs run in **jsdom**, and they render one component at a time. Nothing in them ever looks at the layout.

The usual answer is a pixel-diff snapshot suite, which fails on every anti-aliasing change, every font update and every intentional redesign, until someone updates the baselines without looking. There is a simpler option: take a picture of every page, in both themes and at three widths, put them side by side, and let a human look.

In this article, we will build that **gallery** with Playwright: a script that serves the built Angular application, answers its API calls with fixtures, and writes a contact sheet per theme.


## Prerequisites
Before to start you will need:
- An Angular application that builds to `dist/`.
- [Node.js](https://nodejs.org/) and Playwright, with a Chromium browser:
```bash
npm install --save-dev playwright
npx playwright install chromium
```

> **_Note:_**  The code base this comes from uses `playwright-core` and a `CHROMIUM_PATH` variable instead. Either works.


## Why a gallery and not snapshots?
A snapshot test asks "is this the same as yesterday?". That is the wrong question for layout: most changes are *meant* to change pixels, and a diff cannot tell an improvement from a regression.

A gallery asks "does this look right?", and only a person can answer that. The script only has to guarantee that the person sees **everything**: every route (a regression confined to the billing page is invisible to a gallery that only knows the workspace list), both themes, three widths, and full pages rather than empty states. It fails nothing: it produces images, and the review is reading them.


## Serve the build, not the dev server
The gallery photographs `dist/`, the files we actually deploy. Let's start with a tiny static server, with the fallback to `index.html` that a single-page application behind a router needs:

```typescript
import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, join } from 'node:path';

const DIST = join(process.cwd(), 'dist/browser');

const server = createServer(async (request, response) => {
  const path = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
  const candidate = join(DIST, path);

  if (candidate.startsWith(DIST) && extname(candidate)) {
    try {
      if ((await stat(candidate)).isFile()) {
        createReadStream(candidate).pipe(response);
        return;
      }
    } catch {
      // Falls through to the shell.
    }
  }

  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  createReadStream(join(DIST, 'index.html')).pipe(response);
});

server.listen(4597, '127.0.0.1');
```

A path with an extension (`main.js`, a font) is served from `dist/browser`, anything else (`/workspaces/1/team`) gets `index.html` and the Angular router takes over. The real script also sends a `content-type` per extension, which module scripts need.

## Answer the back end with fixtures
A real application is signed in and calls an API. We don't want to start the back end for a screenshot: that is the job of an end-to-end suite. Instead, Playwright intercepts every request and fulfils it. Here is a simplified version of the code base's `stubApi`:

```typescript
async function stubApi(context) {
  const json = (route, body, status = 200) =>
    route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

  await context.route('**/api/**', async route => {
    const url = new URL(route.request().url());

    // Closing the SSE stream at once stops the page retrying behind every shot.
    if (url.pathname.endsWith('/events/stream')) {
      await route.fulfill({ status: 200, contentType: 'text/event-stream', body: ':ok\n\n' });
      return;
    }

    // Writes are echoed, so a save photographs a success toast and not an error one.
    if (route.request().method() !== 'GET') {
      await route.fulfill({ status: 200, contentType: 'application/json', body: route.request().postData() || '{}' });
      return;
    }

    const matched = respondTo(url.pathname, url.searchParams);

    if (!matched && process.env.GALLERY_TRACE) {
      console.log(`      · no fixture: ${url.pathname}${url.search}`);
    }

    await json(route, matched ?? fallbackFor(url.pathname));
  });
}
```

- `respondTo` walks a list of matchers (a string suffix or a regular expression) and returns a body, or `null`.
- `fallbackFor` returns an empty list rather than an error, so an unknown endpoint never puts an error toast over the picture.
- `GALLERY_TRACE=1` prints every endpoint that fell through. That is the first thing to run when a page looks empty.

The fixtures themselves are a plain `ROUTES` array of `[matcher, () => body]` pairs, `bff/user` answering a signed-in session first.

### Fixtures that make layout fail
This is the most important idea of the whole gallery. A fixture that fits is a fixture that proves nothing. So the data is shaped to *break* the layout, not to look realistic:

```typescript
/** Eleven, one named past its column: the list is longer than a screen, and a long name has to be cut. */
const WORKSPACE_NAMES = [
  'Platform',
  'Design System',
  'Mobile',
  'Growth',
  'Infrastructure, Reliability and Developer Experience',
  'Billing',
  // …five more
];
```

Eleven rows, so the page must scroll. Two organizations. Names longer than the triggers that show them. And **every page is expected to render full**: a shot on an empty state is a missing fixture, not a finding.


## Capture every page, in both themes and three widths
Now the list of what we photograph. Each page carries a sentence saying what the reviewer should look at:

```typescript
export const PAGES = [
  {
    id: 'workspaces',
    route: ORGANIZATION,
    about:
      "the organization's root, which is its workspaces: eleven rows, one name long enough to be cut on a narrow screen, the owner beside it from `sm` and a delete per row",
  },
  { id: 'pricing', route: '/pricing', about: 'the only public route — no shell around it' },
];
```

Keep it **exhaustive**: a route missing from this list is a page nobody looks at.

Then the loop. One browser context per theme and width, reused for every page, because creating a context per shot is most of the runtime:

```typescript
import { chromium } from 'playwright';

const WIDTHS = [
  { name: 'desktop', width: 1280, height: 900 },
  { name: 'tablet', width: 834, height: 1000 },
  { name: 'mobile', width: 410, height: 860 },
];

const browser = await chromium.launch();

for (const theme of ['light', 'dark']) {
  for (const { name, width, height } of WIDTHS) {
    const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1 });
    await stubApi(context);
    const page = await context.newPage();
    await page.emulateMedia({ colorScheme: theme });

    for (const entry of PAGES) {
      await page.goto(base + entry.route, { waitUntil: 'domcontentloaded' });
      await page.waitForLoadState('networkidle').catch(() => undefined);
      await page.waitForTimeout(400);
      await page.screenshot({ path: `.gallery/${theme}-${name}-${entry.id}.png` });
      await page.goto('about:blank');
    }

    await context.close();
  }
}
```

A few details:
- `emulateMedia({ colorScheme })` covers an application that follows `prefers-color-scheme`. If yours keeps the user's choice, set it before the app boots instead, as the code base does with `context.addInitScript(([key, mode]) => localStorage.setItem(key, mode), ['darkMode', theme])`, so the very first paint is already in the right scheme.
- `about:blank` between shots tears the application down, so the next `goto` boots it again instead of routing inside a live one.
- The mobile width, 410px, sits below the shell's 720px breakpoint on purpose: that is where the sidenav becomes a modal.


## Scenes: the states a URL cannot reach
An open select, a toast, a filled-in dialog, a scrolled page: no URL leads there. These are **scenes**, a route plus an `act` function. And each scene names the invariant it holds down, in a `keeps` sentence:

```typescript
{
  id: 'dialog-workspace',
  route: ORGANIZATION,
  keeps:
    'The creation dialog … filled in. Filled in rather than blank: an empty form is the one state where nothing can be seen to overflow, wrap or misalign.',
  act: async page => {
    await page.locator('ui-page-header').getByRole('button', { name: /new workspace/i }).click();
    await page.waitForTimeout(700);

    const dialog = page.getByRole('dialog');

    await dialog.locator('#workspaceName').fill('Customer platform engineering and reliability, Europe');
    return {};
  },
},
```

The runner refuses an entry that says nothing:

```typescript
// A shot nobody knows how to read is not a review.
const unexplained = [...pages.filter(entry => !entry.about?.trim()), ...scenes.filter(entry => !entry.keeps?.trim())];

if (unexplained.length) {
  fail(`entries with nothing said about them: ${unexplained.map(entry => entry.id).join(', ')}`);
}
```

The caption turns a picture into a review: the reviewer knows what to check, and the author had to decide what the shot is for.

A scene can also return a `note`, printed as a warning under the shot. The scroll scene uses it, and scrolls with the **wheel**, not `scrollTop = …`: an element with `overflow: hidden` accepts a written `scrollTop`, so a programmatic scroll moves a page a reader could not have moved.

```typescript
for (let step = 0; step < steps; step++) {
  await page.mouse.wheel(0, 400);
  await page.waitForTimeout(40);
}

if (!moved && !document_) {
  return { moved, note: 'nothing moved under the wheel — the page is clipped inside the shell rather than scrolling in it (#1036)' };
}
```


## The contact sheet
Dozens of separate PNG files are not reviewed. One tall image with every page side by side is, and it is what catches a token change: the one dark page that looks lighter than its neighbours jumps out. The trick is that the sheet is itself an HTML page, photographed by the same browser:

```typescript
const cards = shots
  .map(shot => `
    <figure>
      <figcaption>${shot.id} · ${shot.breakpoint.name}</figcaption>
      <img src="file://${shot.file}" />
      <p>${escape(shot.caption)}</p>
    </figure>`)
  .join('');

const html = `<!doctype html><html><head><style>
  .grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 32px; }
  img { max-width: 100%; max-height: 620px; }
</style></head><body><div class="grid">${cards}</div></body></html>`;

await writeFile(source, html);
await page.goto(`file://${source}`, { waitUntil: 'networkidle' });
await page.screenshot({ path: `.gallery/contact-sheet-${kind}-${theme}.png`, fullPage: true });
```

There is one sheet per theme and per list (`contact-sheet-routes-dark.png`, `contact-sheet-scenes-light.png`), with the widest shot of each page, and the `about` or `keeps` sentence under each image, so the sheet reads as a checklist.


## Narrow it while iterating
A full run is a few minutes. While fixing one page, we don't want all of them, so the runner reads a few flags:

```bash
npm run gallery -- --page=workspaces --theme=dark --no-sheet
npm run gallery -- --only=scenes --width=mobile
GALLERY_TRACE=1 npm run gallery -- --page=organization-billing
```

An unknown id fails the run rather than silently capturing nothing.


## Check that the gallery still catches what it caught
A last idea, and my favourite. 😉 How do we know a scene is useful, and not decoration? We break the application on purpose and look. The code base keeps the regressions the gallery caught as CSS that puts the app back into the broken state:

```typescript
export const REGRESSIONS = {
  'no-scroll': {
    ticket: '#1036',
    shows: 'pages no longer scroll inside the shell',
    css: `app-layout router-outlet + * { min-height: auto !important; overflow-y: visible !important; }`,
  },
};
```

`--regression=no-scroll` injects that rule with `context.addInitScript` into every page and re-captures. If the two contact sheets read the same, the scene proves nothing. `--regression=list` names the known ones.

> **_Note:_**  Only regressions that CSS can reproduce faithfully belong here. A bug that was a DOM change cannot be injected from outside, and a rule that only changes the screenshot proves nothing.


## Conclusion
Unit specs in jsdom answer "does this component behave?". They cannot answer "does this page look right?", and that is where a washed-out theme or a page that stopped scrolling hides. A gallery fills that gap without the brittleness of pixel diffs: serve the build, fulfil the API with `page.route`, loop over themes and widths, and put every shot on a contact sheet for a human to read.

The ideas that make it work are small: fixtures shaped to break the layout, every route listed, a sentence under every shot, and injected regressions to prove a scene still sees what it was written for. Run it after any change to the shell, to a theme token or to a shared component, since those touch every page at once.

This is how visual review is done in [Blouppy Starter](https://starter.blouppy.com/), where the gallery covers every route of the Angular application and the scenes that a URL cannot reach. The [visual review guide](https://docs.starter.blouppy.com/guides/testing/visual-review/) describes how it is run.

*Thanks for reading! 🙂*
