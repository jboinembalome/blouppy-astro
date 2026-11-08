---
templateKey: 'blog-post'
title: 'Moving a blog from Gatsby to Astro without a regression'
date: 2026-11-07T09:00:00.000Z
author: Jimmy Boinembalome
authorimage: /img/jimmy.jpg
category: Astro
topic: 'Testing'
illustration: 2
categorycolor: bg-orange-100 text-orange-800
featuredpost: true
description: >-
  How this blog moved from Gatsby to Astro with the same URLs, HTML and behaviour, and how we proved it: an HTML oracle, pixel diffs and interaction tests on both builds.
tags:
  - Development
  - Astro
  - Gatsby
  - Testing
  - Playwright
---

This blog ran on Gatsby 5 for years. It worked, but every page shipped a client-side router and a GraphQL layer to display what is, in the end, static text. [Astro](https://docs.astro.build/en/concepts/islands/) builds the same pages as plain HTML and only ships JavaScript for the parts that need it.

A migration like this usually ends with "it looks fine". We wanted a stronger claim: **nothing changes for a reader or a crawler**. Same URLs, same `<head>`, same article HTML, same pixels, same interactions. In this article, we will see how we moved the site and, above all, how we proved it.


## The rule: build both and compare
Before touching anything, we built the Gatsby site one last time and kept the output as the reference. Every step of the migration was then checked against it, three ways:

1. **An HTML oracle**: what a crawler and a screen reader get from each page.
2. **Pixel diffs**: what a reader sees, in both themes and at three widths.
3. **Interaction scripts**: what a reader does, such as searching, filtering and copying code.

A difference is either a bug or an intended change. Nothing is left unexplained.


## Keep the URLs
Gatsby built every page as `<path>/index.html` and its `<Link>` added a trailing slash to internal links. Astro does both with two options, and `compressHTML` needs attention too:

```js
// astro.config.mjs
export default defineConfig({
  site: siteUrl,
  trailingSlash: "always",
  build: { format: "directory" },
  // Astro 7 strips whitespace between inline elements by default (React's
  // rules), which would glue words of the articles together.
  compressHTML: true,
});
```

The `compressHTML` line matters: since Astro 7 the default is `'jsx'`, which removes whitespace between inline elements, so `<strong>Astro</strong> <em>7</em>` becomes "Astro7". The [upgrade guide](https://docs.astro.build/en/guides/upgrade-to/v7/) documents it. The oracle caught it on the first build.

The components kept their `Link`, now a small wrapper that renders an `<a>` with the trailing slash and `aria-current="page"`, as Gatsby's did.


## Keep the article HTML
The articles' HTML came from `gatsby-transformer-remark` and its plugins: heading anchors, Prism highlighting with line numbers, copy buttons, responsive images. Astro's own Markdown pipeline produces different HTML: other heading ids, other highlighting markup. Every anchor shared on social networks and every style would have been at risk.

So we kept the pipeline. The articles go through the same libraries, at the same versions (remark 13, `mdast-util-to-hast` 10, `hast-util-to-html` 7), and the three plugins are vendored with their licences. Astro calls it at build time:

```ts
// src/lib/markdown/index.ts
// The pipeline is CommonJS (the remark 13 ecosystem Gatsby used), loaded with
// Node's own require rather than through the bundler.
const require = createRequire(join(process.cwd(), "src/lib/markdown/"));
const { render } = require("./vendor/pipeline.js");

export const renderMarkdown = (markdown: string) =>
  render(markdown, { tocMaxDepth: 3, excerptLengths: [140, 200, 5000] });
```

The same function returns the table of contents, the reading time (265 words a minute, as Gatsby counted) and the excerpts for the cards, the RSS feed and the search index. On the first comparison, 42 of the 44 article bodies were identical. The two others contain images, whose responsive markup `gatsby-remark-images` generated; we reproduced it, and the only difference left is an aspect ratio rounded differently, worth one pixel in one screenshot.

Pinning old versions has a cost: Renovate is told never to propose a new minor or major for these packages, and only patches come, for review.


## Reuse the components, hydrate only the islands
The pages were React components, and Astro renders React on the server. We kept them, and chose per component what needs JavaScript:

- the navbar (`client:load`): menu, theme, search;
- the Articles page (`client:load`): topic filters and infinite scroll;
- the table of contents (`client:idle`): it highlights the section being read;
- the comments (`client:visible`): Disqus loads when the reader reaches them.

The article itself is a React component that renders its table of contents and comments. Astro cannot hydrate a component nested inside another React component, but it can pass hydrated islands through **named slots**:

```tsx
---
// src/pages/blog/[slug].astro
---
<BlogPostTemplate content={html} title={frontmatter.title} tableOfContents={toc} related={related}>
  <ArticleToc slot="toc" client:idle html={toc} />
  <ArticleComments slot="comments" client:visible disqusConfig={disqusConfigOf(slug, frontmatter.title)} />
</BlogPostTemplate>
```

On the React side, the slots arrive as props (`toc` and `comments`), so the article stays static HTML and only those two parts are hydrated. The CMS previews render the same component without slots.


## An HTML oracle
The first check reads each built page the way a crawler would. A short Python script with Beautiful Soup extracts, page by page, everything that matters and writes it to JSON:

```python
def page(path):
    soup = BeautifulSoup(open(path, encoding="utf-8").read(), "lxml")
    meta = {}
    for m in soup.head.find_all("meta"):
        key = m.get("name") or m.get("property") or m.get("http-equiv")
        if key:
            meta.setdefault(key.lower(), []).append(norm(m.get("content")))
    return {
        "title": norm(soup.head.title.get_text()),
        "meta": meta,
        "jsonld": [json.loads(s.string) for s in soup.find_all("script", type="application/ld+json")],
        "headings": [[h.name, norm(h.get_text(" ")), h.get("id")] for h in soup.body.find_all(["h1", "h2", "h3"])],
        "anchors": [[a.get("href"), norm(a.get_text(" "))] for a in soup.body.find_all("a")],
        "images": [[norm_src(i.get("src")), i.get("alt")] for i in soup.body.find_all("img")],
        "code": [norm(p.get_text()) for p in soup.body.find_all("pre")],
        "main_text": norm((soup.body.find("main") or soup.body).get_text(" ")),
    }
```

Running it on both builds and diffing the two JSON files gives a report grouped by kind of difference: `meta:og:image` on one page, `anchors` on three pages, and so on. Asset paths are compared by file name, since hashes differ. The sitemap, the RSS feed, `robots.txt` and the manifest are compared as files.

At the end, the only differences were the intended ones: the `generator` meta tag was gone, the footer said "Built with Astro", and resized photos had new paths.


## Pixel diffs
The oracle says nothing about CSS. For that, [Playwright](https://playwright.dev/docs/screenshots) took full-page screenshots of ten pages, in both themes, at 375, 768 and 1280 pixels, plus every article. Two settings make them comparable: third-party scripts are blocked, and animations are frozen.

```js
await context.route(/buymeacoffee|disqus|googletagmanager|algolia/, (route) => route.abort());
await page.goto(url, { waitUntil: "networkidle" });
await page.addStyleTag({
  content: "*,*::before,*::after{animation:none!important;transition:none!important}",
});
await page.screenshot({ path, fullPage: true });
```

A few lines of Pillow compare the images and report the bounding box of what differs. This found what the oracle could not:

- **CSS order**: Gatsby loaded Prism's styles after the site's. Loading them before shifted line numbers by a fraction of a pixel.
- **A crop**: the About portrait used a 4:5 ratio that Gatsby's image wrapper applied implicitly.
- **Minifiers**: the new CSS minifier wrote `30.0001px` where the old one wrote `30px`, which moved antialiasing but nothing visible. A diff is not always a bug, but it always deserves a look.

When a diff is hard to read, comparing the bounding box and computed style of every element (`getBoundingClientRect()` and `getComputedStyle()`) on both builds points at the first one that moved.


## Interactions
Screenshots show a page at rest. Short Playwright scripts then replayed what a reader does, on both builds, and printed the outcome:

- the mobile menu opens and closes after a link is followed;
- the search dialog opens, finds an article and closes once a result is followed (with Algolia's responses mocked);
- the topic filter updates the URL, and infinite scroll reveals all 44 articles;
- the table of contents highlights the section being read;
- the copy button copies the code;
- the contact form posts to Netlify Forms, then shows the thanks page.

The two outputs had to be identical, and React's hydration had to report no error on any page.


## The deploy
The site built on Netlify, then failed. Netlify had installed its Gatsby plugin automatically when the site was created, as the Gatsby runtime. Since no Gatsby cache existed any more, the plugin's `onBuild` step crashed. The plugin skips its work when the `NETLIFY_SKIP_GATSBY_BUILD_PLUGIN` variable is set (its source checks it first), which unblocked the deploy until the runtime was removed from the site's settings:

```toml
# netlify.toml
[build.environment]
  NETLIFY_SKIP_GATSBY_BUILD_PLUGIN = "true"
```

The deploy log taught us one more thing. The Algolia admin key was also set for deploy previews, so a preview replaced the production search index. The indexing script now runs for production builds only.


## Conclusion
A framework migration can be shown to change nothing, not just claimed. Keep the reference build, compare what a crawler reads, what a reader sees and what a reader does, and explain every difference. The same three checks now run on every pull request of this blog: a site check on the built HTML, and Playwright tests in a browser.

The code of this blog, including the Astro configuration and the vendored Markdown pipeline, is on [GitHub](https://github.com/jboinembalome/blouppy-blog).


## References
- [Astro islands](https://docs.astro.build/en/concepts/islands/) — the architecture and the `client:*` directives.
- [Front-end frameworks in Astro](https://docs.astro.build/en/guides/framework-components/) — React components, nesting and named slots.
- [Migrating from Gatsby](https://docs.astro.build/en/guides/migrate-to-astro/from-gatsby/) — Astro's guide.
- [Upgrade to Astro v7](https://docs.astro.build/en/guides/upgrade-to/v7/) — including the new `compressHTML` default.
- [Astro configuration reference](https://docs.astro.build/en/reference/configuration-reference/) — `trailingSlash`, `build.format`, `compressHTML`.
- [gatsby-transformer-remark](https://www.npmjs.com/package/gatsby-transformer-remark) — the Markdown pipeline kept here.
- [Playwright screenshots](https://playwright.dev/docs/screenshots) — full-page captures.
- [Netlify: Gatsby on Netlify](https://docs.netlify.com/build/frameworks/framework-setup-guides/gatsby/) — the runtime and its plugin.
- [Essential Gatsby plugin](https://github.com/netlify/netlify-plugin-gatsby) — the plugin Netlify adds to Gatsby sites, and the variable that skips it.
