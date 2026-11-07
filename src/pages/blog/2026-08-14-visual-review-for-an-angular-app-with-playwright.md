---
templateKey: 'blog-post'
title: 'Visual review for an Angular app: a Playwright gallery of every page'
date: 2026-08-14T09:00:00.000Z
updated: 2026-11-07T09:00:00.000Z
author: Jimmy Boinembalome
authorimage: /img/jimmy.jpg
category: Angular
topic: 'Testing'
illustration: 3
categorycolor: bg-red-100 text-red-800
featuredpost: true
featuredimage: /img/visual-review-for-an-angular-app-with-playwright.jpg
description: >-
  Learn how to build a Playwright gallery that photographs every route of an Angular app, in both themes and three widths, so a human can review the layout unit tests never see.
tags:
  - Development
  - Angular
  - Playwright
  - Testing
  - CSS
---

Our unit specs are green, and yet the dark theme ships washed out, or a page stops scrolling inside the shell: specs in **jsdom** render one component at a time and never look at the layout. A pixel-diff [snapshot suite](https://playwright.dev/docs/test-snapshots) asks the wrong question, "is this the same as yesterday?", when most changes are *meant* to change pixels.

In this article, we will build a **gallery** with [Playwright](https://playwright.dev/docs/library) instead: a script that photographs every page of the built Angular application, in both themes and three widths, answers its API calls with fixtures, and lays the shots out on contact sheets for a human to review.

You need an Angular application that [builds](https://angular.dev/tools/cli/build) to `dist/`, [Node.js](https://nodejs.org/), and Playwright with Chromium:

```bash
npm install --save-dev playwright
npx playwright install chromium
```

The code base this comes from uses `playwright-core` and passes a `CHROMIUM_PATH` variable to `chromium.launch({ executablePath })` instead; either works.


## Serve the build, not the dev server
The gallery photographs `dist/`, the files we deploy. A small static server is enough, with the fallback to `index.html` that a routed single-page application needs:

```typescript
// ... imports from node:http, node:fs, node:fs/promises and node:path

const DIST = join(process.cwd(), 'dist/browser');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };

const server = createServer(async (request, response) => {
  const path = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
  const candidate = join(DIST, path);

  if (candidate.startsWith(DIST) && extname(candidate)) {
    try {
      if ((await stat(candidate)).isFile()) {
        response.writeHead(200, { 'content-type': MIME[extname(candidate)] ?? 'application/octet-stream' });
        createReadStream(candidate).pipe(response);
        return;
      }
    } catch {
      // Falls through to the shell.
    }
  }

  response.writeHead(200, { 'content-type': MIME['.html'] });
  createReadStream(join(DIST, 'index.html')).pipe(response);
});

server.listen(4597, '127.0.0.1');
```

A path with an extension (`main.js`, a font) is served from `dist/browser`; anything else (`/workspaces/1/team`) gets `index.html`, and the Angular router takes over. The `content-type` matters: the browser refuses a module script served with the wrong one. The real script maps more extensions and tries the next port when one is taken.

## Answer the back end with fixtures
The application is signed in and calls an API, but starting the back end is the job of an end-to-end suite. Instead, Playwright [intercepts every request](https://playwright.dev/docs/mock) and fulfils it. Here is a simplified version of the code base's `stubApi`:

```typescript
async function stubApi(context) {
  const json = (route, body, status = 200) =>
    route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

  await context.route('**/api/**', async route => {
    const url = new URL(route.request().url());

    // Writes are echoed, so a save photographs a success toast and not an error one.
    if (route.request().method() !== 'GET') {
      await route.fulfill({ status: 200, contentType: 'application/json', body: route.request().postData() || '{}' });
      return;
    }

    const matched = respondTo(url.pathname, url.searchParams);

    // ... logs the unmatched path when GALLERY_TRACE is set

    await json(route, matched ?? fallbackFor(url.pathname));
  });
}
```

- `respondTo` walks a `ROUTES` array of `[matcher, () => body]` pairs (a path suffix or a regular expression) and returns a body, or `null`. `bff/user` comes first and answers with a signed-in session; the real script routes `**/bff/**` and `**/identity/**` the same way.
- `fallbackFor` returns an empty list rather than an error, so an unknown endpoint never puts an error toast over the picture. `GALLERY_TRACE=1` prints every endpoint that fell through: the first thing to run when a page looks empty.
- The real script also answers the server-sent event stream with an empty `text/event-stream` body at once, which stops the page retrying behind every shot.

### Fixtures that make layout fail
A fixture that fits proves nothing, so the data is shaped to *break* the layout, not to look realistic:

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

Eleven rows, so the page must scroll; two organizations; names longer than the triggers that show them. **Every page is expected to render full**: a shot of an empty state is a missing fixture, not a finding.


## Capture every page, in both themes and three widths
Each entry of the `PAGES` list carries an `about` sentence saying what the reviewer should look at, such as `{ id: 'pricing', route: '/pricing', about: 'the only public route — no shell around it' }`. Keep the list **exhaustive**: a route missing from this list is a page nobody looks at.

Then the loop (simplified). One [browser context](https://playwright.dev/docs/api/class-browsercontext) per theme and width, reused for every page, because creating a context per shot is most of the runtime:

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

await browser.close();
```

- [`emulateMedia({ colorScheme })`](https://playwright.dev/docs/api/class-page#page-emulate-media) covers an application that follows [`prefers-color-scheme`](https://developer.mozilla.org/docs/Web/CSS/@media/prefers-color-scheme). If yours stores the user's choice, write it before the app boots instead, as the code base does with `context.addInitScript(([key, mode]) => localStorage.setItem(key, mode), ['darkMode', theme])`, so the first paint is already in the right scheme.
- `about:blank` between shots tears the application down, so the next `goto` boots it afresh. The 410px width sits below the shell's 720px breakpoint, where the sidenav becomes a modal.

> **_Note:_**  Playwright discourages `networkidle` and fixed timeouts in tests. The code base accepts both to let animations settle, but also waits for its spinners and skeletons to detach, which is the more reliable signal.


## Scenes: the states a URL cannot reach
An open select, a toast, a filled-in dialog, a scrolled page: no URL leads there. These are **scenes**, a route plus an `act` function, and each one names the invariant it holds down in a `keeps` sentence (abridged):

```typescript
{
  id: 'dialog-workspace',
  route: ORGANIZATION,
  keeps:
    'The creation dialog … filled in. Filled in rather than blank: an empty form is the one state where nothing can be seen to overflow, wrap or misalign.',
  act: async page => {
    await page.locator('ui-page-header').getByRole('button', { name: /new workspace/i }).click();
    await settle(page, 700);
    await page.getByRole('dialog').locator('#workspaceName').fill('Customer platform engineering and reliability, Europe');
    // ... picks a colour too
    return {};
  },
},
```

The runner refuses, before capturing anything, an entry whose `about` or `keeps` is empty: the caption tells the reviewer what to check, and forces the author to decide what the shot is for.

A scene can also return a `note`, printed as a warning under the shot. The scroll scene scrolls with [`page.mouse.wheel(0, 400)`](https://playwright.dev/docs/api/class-mouse#mouse-wheel), not `scrollTop = …`, because an element with `overflow: hidden` accepts a written `scrollTop`, and returns a note when nothing moved.


## The contact sheet
Dozens of PNG files do not get reviewed; one tall image with every page side by side does, and it is what catches a token change, because the one dark page lighter than its neighbours jumps out. The sheet is itself an HTML page, a two-column grid of `<figure>` elements (shot, id, width, HTML-escaped caption), opened with `page.goto('file://…')` and captured with [`fullPage: true`](https://playwright.dev/docs/screenshots). There is one per theme and per list (`contact-sheet-routes-dark.png`, `contact-sheet-scenes-light.png`), with the widest shot of each page, so it reads as a checklist.

A full run takes a few minutes. While fixing one page, flags narrow it: `--page=`, `--scene=`, `--only=pages|scenes`, `--theme=`, `--width=` and `--no-sheet`, as in `npm run gallery -- --page=workspaces --theme=dark --no-sheet`. An unknown id fails the run rather than silently capturing nothing.


## Check that the gallery still catches what it caught
To know a scene is useful and not decoration, break the application on purpose and look. The code base keeps the regressions the gallery caught as CSS that puts the app back into the broken state:

```typescript
export const REGRESSIONS = {
  'no-scroll': {
    ticket: '#1036',
    shows: 'pages no longer scroll inside the shell',
    css: `app-layout router-outlet + * { min-height: auto !important; overflow-y: visible !important; }`,
  },
};
```

`--regression=no-scroll` injects that rule into every page with [`context.addInitScript`](https://playwright.dev/docs/api/class-browsercontext#browser-context-add-init-script) and re-captures. If the two contact sheets read the same, the scene proves nothing. `--regression=list` names the known ones.

> **_Note:_**  Only regressions that CSS can reproduce faithfully belong here. A bug that was a DOM change cannot be injected from outside, and a rule that only changes the screenshot proves nothing.


## Conclusion
A gallery answers what jsdom specs cannot, "does this page look right?", without the brittleness of pixel diffs: serve the build, fulfil the API with `context.route`, loop over themes and widths, and put every shot on a contact sheet. Run it after any change to the shell, a theme token or a shared component, since those touch every page at once.

This is how visual review works in [Blouppy Starter](https://starter.blouppy.com/). The [visual review guide](https://docs.starter.blouppy.com/guides/testing/visual-review/) describes how to run it.


## References
- [Playwright Library](https://playwright.dev/docs/library) — using Playwright from a plain Node.js script.
- [Mock APIs](https://playwright.dev/docs/mock) — intercepting and fulfilling network requests with `route`.
- [Route class](https://playwright.dev/docs/api/class-route) — `route.fulfill()` and its options.
- [Page class](https://playwright.dev/docs/api/class-page) — `goto`, `emulateMedia`, `screenshot` and the load states.
- [BrowserContext class](https://playwright.dev/docs/api/class-browsercontext) — viewports, `addInitScript` and context-wide routing.
- [Screenshots](https://playwright.dev/docs/screenshots) — full-page and clipped screenshots.
- [Visual comparisons](https://playwright.dev/docs/test-snapshots) — Playwright's pixel-diff alternative.
- [Building Angular apps](https://angular.dev/tools/cli/build) — the build output in `dist/<project>/browser`.
- [prefers-color-scheme](https://developer.mozilla.org/docs/Web/CSS/@media/prefers-color-scheme) — the media feature `emulateMedia` sets.
- [Blouppy Starter: Visual review](https://docs.starter.blouppy.com/guides/testing/visual-review/) — the gallery this article describes.
