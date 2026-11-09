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

A product needs a documentation site, and the team already writes Angular. The usual advice is a dedicated generator, and it is often right. But a second toolchain has a price: another framework to upgrade, and a design system rebuilt for the documentation alone.

The other road is to make Angular do the job. Angular can prerender every route to static HTML at build time. The missing pieces are a way to turn markdown into pages, and a search that needs no server.


## A markdown page is a component template
Angular templates are HTML. A markdown page rendered to HTML can therefore *be* a component template, with no markdown parser in the browser. A small Node script runs before `ng build` and writes a component and a route per file:

```js
// tools/build-content.mjs (minimal)
const md = new MarkdownIt({ html: true });
const routes = [];

for (const file of (await readdir('content')).filter(f => f.endsWith('.md'))) {
  const name = file.replace(/\.md$/, '');
  const { data, content } = matter(await readFile(`content/${file}`, 'utf8'));

  await writeFile(`src/app/generated/${name}.html`, md.render(content));
  await writeFile(
    `src/app/generated/${name}.ts`,
    `import { Component } from '@angular/core';
@Component({ selector: 'docs-${name}', templateUrl: './${name}.html' })
export class Page {}
`,
  );
  routes.push(`{ path: '${name}', title: '${data.title}', loadComponent: () => import('./${name}').then(m => m.Page) }`);
}

await writeFile('src/app/generated/routes.ts', `export const contentRoutes = [${routes.join(',')}];`);
```

An npm `prebuild` script runs it, and `src/app/generated` goes in `.gitignore`: the folder is rebuilt on every build and never edited by hand.

Prerendering takes two settings with `@angular/ssr`. The build gets a server entry and `"outputMode": "static"` in `angular.json`, and a single server route asks for `RenderMode.Prerender` on `'**'`. The builder reads the router configuration to find the pages. The generated routes are literal paths with no `:id`, so every page is found without a `getPrerenderParams`.

[Blouppy Starter](https://starter.blouppy.com/) builds its product documentation this way, in `front/docs/`, with more care in each step. Its script also highlights code at build time with [Shiki](https://shiki.style/), turns GitHub alerts (`> [!WARNING]`) into a callout component, and writes the sidebar. Each page imports only the content components its HTML uses.


## Angular reads your prose as code
This is the pitfall specific to Angular. A template is not inert HTML: `{{ }}` is interpolation, a single `{` opens an ICU message, and `@if` starts a control-flow block. Documentation is full of all three: a JSON sample, an e-mail address, a page about Angular itself. The build then fails far from the cause, because Shiki wraps each token in its own `<span>` and the ICU parser swallows the closing tags.

So the Starter escapes every text node and leaves markup alone:

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

Entities alone are not enough. Angular decodes `&#123;&#123;` back to `{{` before it looks for interpolation. An empty comment between the two braces splits the text node, and Angular drops the comment. A `<style>` element keeps its braces, because a diagram's SVG carries CSS. A Vitest spec pins each of these cases.


## Diagrams rendered once
Mermaid needs a browser to lay out a diagram. Shipping it to readers costs a large bundle, and rendering at build time needs Chromium on every machine that builds. The Starter does neither. The script renders each diagram in Chromium, in a light and a dark variant, and stores the SVGs in `content/.diagrams/`, **committed** with the markdown. The file name is a hash of the diagram source, so an unchanged diagram is never rendered again. CI and the Docker image only read that cache and never launch a browser.


## Search with Pagefind
[Pagefind](https://pagefind.app/) indexes a folder of built HTML and writes a static index next to it. The Starter runs it in `postbuild`, on the prerendered output. The layout marks the article with `data-pagefind-body`, so the sidebar is not indexed on every page.

The index does not exist when Angular builds, so it cannot be a static import. The search dialog loads it on first open, with the path in a variable so the bundler does not try to resolve it (simplified):

```ts
const PAGEFIND_ENTRY = '/_pagefind/pagefind.js';

private async load(): Promise<PagefindModule | null> {
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

The index costs nothing until the reader opens search. There is no server and no third-party account. The one gap is development: the index only exists after a full build, so search fails quietly under `ng serve`.


## Angular or a generator?
For a team starting from nothing, a dedicated tool is usually better. [Starlight](https://starlight.astro.build/) ships the sidebar, the table of contents, dark mode and Pagefind search out of the box. VitePress suits a Vue team, Docusaurus a React team with versioned docs. None of them has to escape markdown out of an Angular template.

Staying in Angular pays off when the design system is in Angular and must be shared. The Starter has four front-end apps in one npm workspace, and the docs import the app's tokens and components, so they look like the app because they *are* the same components. The price is a build script to own, with its own tests, and an escaper that every new markdown feature must go through. Pick a generator when docs are a product in themselves, with versions, many languages or many contributors.


## References
- [Angular: prerendering](https://angular.dev/guide/prerendering) — `outputMode`, `RenderMode.Prerender` and how routes are discovered.
- [Pagefind](https://pagefind.app/) — the static search index, its CLI and its JavaScript API.
- [markdown-it](https://github.com/markdown-it/markdown-it) — the markdown parser and its rule system.
- [Starlight](https://starlight.astro.build/) — Astro's documentation theme, the usual alternative.
