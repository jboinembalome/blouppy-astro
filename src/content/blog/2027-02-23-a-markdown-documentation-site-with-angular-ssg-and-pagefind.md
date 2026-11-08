---
templateKey: 'blog-post'
title: 'A markdown documentation site with Angular SSG and Pagefind'
date: 2027-02-23T09:00:00.000Z
author: Jimmy Boinembalome
authorimage: /img/jimmy.jpg
category: Angular
topic: 'Tooling'
illustration: 2
categorycolor: bg-red-100 text-red-800
featuredpost: true
description: >-
  Build a product documentation site in Angular: markdown compiled into one component per page, Mermaid diagrams as committed SVGs, every route prerendered and a Pagefind index.
tags:
  - Development
  - Angular
  - Playwright
---

A product needs a documentation site, and the team already writes Angular. The usual advice is a dedicated generator, and it is often right. But a second toolchain has a price: another framework to upgrade, another way to write components, and a design system that has to be rebuilt or copied for the documentation alone.

The other road is to make Angular do the job. Angular can prerender every route to static HTML at build time, so the missing pieces are a way to turn markdown into pages and a search that needs no server.

In this article, we will build that pipeline: a build step that compiles `content/**/*.md` into one standalone component per page, Mermaid diagrams rendered once and committed as SVG, every route prerendered, and a [Pagefind](https://pagefind.app/) index for client-side search. Then we will compare it honestly with Starlight, VitePress and Docusaurus.


## The idea
Angular templates are HTML. A markdown page rendered to HTML can therefore *be* a component template, with no markdown parser in the browser. A small Node script runs before `ng build`, writes a component and a route per file, and the Angular build does the rest.

A minimal version fits in a few lines:

```js
// tools/build-content.mjs (minimal)
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import matter from 'gray-matter';
import MarkdownIt from 'markdown-it';

const md = new MarkdownIt({ html: true });
const routes = [];

for (const file of (await readdir('content')).filter(f => f.endsWith('.md'))) {
  const name = file.replace(/\.md$/, '');
  const { data, content } = matter(await readFile(`content/${file}`, 'utf8'));

  await mkdir('src/app/generated', { recursive: true });
  await writeFile(`src/app/generated/${name}.html`, md.render(content));
  await writeFile(
    `src/app/generated/${name}.ts`,
    `import { Component } from '@angular/core';
@Component({ selector: 'docs-${name}', templateUrl: './${name}.html' })
export class Page {}
`);
  routes.push(`{ path: '${name}', title: '${data.title}', loadComponent: () => import('./${name}').then(m => m.Page) }`);
}

await writeFile('src/app/generated/routes.ts', `export const contentRoutes = [${routes.join(',')}];`);
```

Wire it with npm's `pre` scripts (`"prebuild": "node tools/build-content.mjs"`), add `src/app/generated` to `.gitignore`, and the generated folder is rebuilt on every build and never edited by hand.


## Prerendering every route
With `@angular/ssr`, the application builder can emit a static file per route. Two settings do it. In `angular.json`, the build gets a server entry and the static output mode:

```json
"options": {
  "browser": "src/main.ts",
  "server": "src/main.server.ts",
  "outputMode": "static"
}
```

And the server routes ask for prerendering everywhere:

```ts
import { RenderMode, ServerRoute } from '@angular/ssr';

export const serverRoutes: ServerRoute[] = [
  {
    path: '**',
    renderMode: RenderMode.Prerender,
  },
];
```

The builder reads the router configuration to find the routes. Because the generated routes are literal paths, with no `:id` parameter, every page is discovered without a `getPrerenderParams`.


## The real pipeline
In [Blouppy Starter](https://starter.blouppy.com/), the product documentation lives in `front/docs/` and follows this shape, with more care in each step. The scripts in `package.json` tell the order:

```json
"content": "node tools/build-content.mjs",
"prebuild": "npm run content",
"build": "ng build",
"postbuild": "npm run search-index",
"search-index": "pagefind --site dist/blouppy-docs/browser --output-subdir _pagefind",
"predev": "npm run content",
"pretest": "npm run content"
```

`npm run build` compiles the content, builds and prerenders, then indexes the output. Each folder under `content/` is a section, and each file's front matter carries its `title`, `description`, `group` and `order`. The route mirrors the path: `content/guide/workspaces/teams.md` becomes `/guide/workspaces/teams`.

For each file, `buildPage` writes a template and a class. The class imports only the content components its HTML uses (`docs-callout`, `docs-steps`, `docs-figure`), so a prose-only page pulls in nothing.

GitHub alert syntax (`> [!WARNING]`) becomes a `<docs-callout>` through a markdown-it core rule, and code is highlighted at build time by [Shiki](https://shiki.style/) with a light and a dark theme baked into CSS variables, so the theme switcher recolours code without highlighting it again. The script also emits `routes.ts`, `nav.ts` (sidebar, table of contents, previous and next links) and the site settings from `_site.json`.


## Angular reads your prose as code
This is the pitfall specific to Angular. A template is not inert HTML: `{{ }}` is interpolation, a single `{` opens an ICU message, and `@if` starts a control-flow block. Documentation is full of all three: a JSON sample, an e-mail address, a page explaining Angular itself. The build then fails with errors far from the cause, because Shiki wraps each token in its own `<span>` and the ICU parser swallows the closing tags.

So every text node is escaped, and markup is left alone:

```js
function escapeAngularSyntax(html) {
  const escapeText = text =>
    text
      .replace(/\{/g, '&#123;')
      .replace(/\}/g, '&#125;')
      .replace(/@/g, '&#64;')
      .replace(/&#123;(?=&#123;)/g, '&#123;<!---->');

  return html.replace(/(<style[\s\S]*?<\/style>)|(<[^>]*>)|([^<]+)/g, (match, style, tag, text) => (text ? escapeText(text) : match));
}
```

- Entities alone are not enough: Angular decodes `&#123;&#123;` back to `{{` before it looks for interpolation. An empty comment between the two braces splits the text node, and Angular drops the comment.
- A `<style>` element keeps its braces, because Mermaid's SVG carries CSS. The text of the SVG is escaped like any other: a label such as `GET /items/{id}` is an ICU message there too.

A Vitest spec imports the script's exports and pins each case, with names such as `Should_split_interpolation_delimiters_when_prose_contains_double_braces`.


## Mermaid without Chromium in CI
Mermaid needs a browser to lay out a diagram. Shipping Mermaid to readers would cost a large bundle on every page with a diagram, and rendering at build time needs Chromium on every machine that builds. The Starter does neither: the script renders each diagram in the Chromium that `playwright-core` drives, then stores the result in `content/.diagrams/`, **committed** with the markdown.

```js
async function renderMermaid(code) {
  const hash = createHash('sha256').update(code).digest('hex').slice(0, 16);
  const variants = {};

  for (const variant of DIAGRAM_VARIANTS) {
    const cacheFile = join(mermaidCacheDir, `${hash}-${variant.name}.svg`);

    if (existsSync(cacheFile)) {
      variants[variant.name] = await readFile(cacheFile, 'utf8');
      continue;
    }

    const context = await getMermaidPage();

    if (!context) {
      console.warn(`  ! Mermaid unavailable (${mermaidUnavailableReason}); emitting the diagram source instead.`);
      return `<div class="code-block" data-lang="mermaid">${await renderCode(code, 'text')}</div>`;
    }

    // ... renders with mermaid.render() in the page, writes cacheFile
  }

  return wrapDiagram(variants);
}
```

- The file name is a hash of the diagram source, so an unchanged diagram is never rendered again and an edited one gets new files.
- Each diagram is rendered twice, `neutral` and `dark`. A build-time SVG cannot follow the theme switcher, so CSS shows the variant that matches.
- Only the machine that adds or edits a diagram needs Chromium. CI and the Docker image (`node:24`, then `nginx:alpine`) read the cache and never launch a browser.
- Without Chromium and without a cached file, the build warns and prints the source as a code block instead of failing.

The script injects Mermaid's UMD bundle (`mermaid.min.js`) into an `about:blank` page, because the ESM build lazy-loads its chunks over the network, which never resolves there.


## Search with Pagefind
[Pagefind](https://pagefind.app/) indexes a folder of built HTML and writes a static index next to it. The Starter runs it after the build, with `--site` pointing at the prerendered output and `--output-subdir _pagefind`. The layout marks the article with `data-pagefind-body`, so the sidebar and navbar are not indexed on every page. Pagefind then leaves out pages with no such element, which is why the home page is not in the results.

The index does not exist when Angular builds, so it cannot be a static import. The search dialog loads it on first open, with the path in a variable so the bundler does not try to resolve it:

```ts
const PAGEFIND_ENTRY = '/_pagefind/pagefind.js';

private async load(): Promise<PagefindModule | null> {
  if (this._pagefind || !this._isBrowser) {
    return this._pagefind;
  }

  try {
    const module = (await import(/* @vite-ignore */ PAGEFIND_ENTRY)) as PagefindModule;

    await module.init();
    this._pagefind = module;
  } catch {
    // The index is missing during `ng serve`, which is expected.
    this.failed.set(true);
  }

  return this._pagefind;
}
```

`search(term)` returns results whose `data()` gives a `url`, an `excerpt` and the page title in `meta`. The URLs are those of the prerendered files, so the dialog strips `index.html` and `.html` before calling `router.navigateByUrl`. The index costs nothing until the reader opens search, and there is no server and no third-party account.


## Why stay in Angular
The Starter has four front-end apps (the application, the landing page, this documentation site and a design-system playground) in one npm workspace with one lockfile. All four consume `@blouppy/ui` as source: the docs import its tokens, its Tailwind preset, its theme selector and its logo, so the documentation looks like the app because it *is* the same components and the same [CSS tokens](/blog/2026-06-27-runtime-theming-with-css-tokens-and-tailwind-4/). One framework version, one ESLint and Prettier setup, one way to write a component, and the same [Playwright gallery](/blog/2026-08-14-visual-review-for-an-angular-app-with-playwright/) to review the rendering. For a starter kit, there is one more reason: the buyer already knows Angular, and the docs are sample content to replace, so the pipeline must be something they can read.


## When a dedicated generator is simply better
For most teams starting a documentation site from nothing, a dedicated tool is the better choice:

- **Starlight (Astro)** ships the sidebar, the table of contents, internationalisation, dark mode and Pagefind search out of the box. This blog [moved to Astro](/blog/2026-11-07-moving-a-blog-from-gatsby-to-astro-without-a-regression/) for content of exactly this kind.
- **VitePress** is the natural pick for a Vue team: markdown with Vue components inside, fast dev server, and a built-in local search.
- **Docusaurus** fits React teams and large documentation sets: versioned docs and internationalisation are built in, and its ecosystem of plugins is wide.

Each has solved problems the Starter's script leaves to us, and none of them has to escape markdown out of an Angular template.

Stay in Angular when the design system is in Angular and must be shared, when the team will not maintain a second framework, and when the documentation needs few features beyond pages, diagrams and search. Pick a generator when docs are a product in themselves, with versions, many languages or many contributors.


## What it costs
- **A script to own.** About 850 lines of build code, with its own tests, that nobody upstream maintains.
- **Template escaping.** Every new markdown feature that emits HTML has to go through the escaper, or one page breaks the build.
- **A committed cache.** Stale SVGs of deleted or edited diagrams are not pruned automatically; someone removes them by hand.
- **No dev search.** The index exists only after a full build, so search fails quietly under `ng serve`.


## Conclusion
Angular's static output mode turns a markdown pipeline into a small job: compile each page into a standalone component before the build, prerender every literal route, and index the result with Pagefind afterwards. Escape every text node, render diagrams once and commit them, and load the search index only when it is needed. It is not the shortest path to a documentation site, and Starlight, VitePress or Docusaurus will often serve better. It is the right one when the documentation must share the app's design system and toolchain, as it does in [Blouppy Starter](https://starter.blouppy.com/).


## References
- [Angular: server-side and hybrid rendering](https://angular.dev/guide/ssr) — `outputMode`, `ServerRoute` and `RenderMode.Prerender`.
- [Angular: prerendering](https://angular.dev/guide/prerendering) — how routes are discovered and when `getPrerenderParams` is needed.
- [Pagefind](https://pagefind.app/) — the static search index, its CLI and its JavaScript API.
- [Pagefind: configuring what is indexed](https://pagefind.app/docs/indexing/) — `data-pagefind-body` and its effect on other pages.
- [markdown-it](https://github.com/markdown-it/markdown-it) — the markdown parser and its rule system.
- [Shiki](https://shiki.style/) — build-time syntax highlighting with dual themes.
- [Mermaid](https://mermaid.js.org/) — the diagram syntax and its `render` API.
- [Starlight](https://starlight.astro.build/) — Astro's documentation theme.
- [VitePress](https://vitepress.dev/) — Vue's static site generator for documentation.
- [Docusaurus](https://docusaurus.io/) — React's documentation framework, with versioning.
