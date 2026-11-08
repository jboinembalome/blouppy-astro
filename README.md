# Blouppy

[![Netlify Status](https://api.netlify.com/api/v1/badges/3684b748-42a1-4cd6-a7a4-8b7ab1edcd19/deploy-status)](https://app.netlify.com/projects/blouppy/deploys)

The source of **[Blouppy](https://www.blouppy.com/)**, a blog on software engineering: architecture, security, testing, back end and front end.

It is a static site built with [Astro](https://astro.build/), with [React](https://react.dev/) for the interactive parts, styled with [Tailwind CSS](https://tailwindcss.com/), edited through [Decap CMS](https://decapcms.org/) and deployed by [Netlify](https://www.netlify.com/).

## What it does

- Articles written in Markdown (`src/content/blog/`), with a table of contents, syntax highlighting, line numbers and copy buttons.
- An Articles page filtered by topic, revealed as the reader scrolls; a page per tag.
- Search with [Algolia](https://www.algolia.com/), loaded the first time the dialog opens.
- Light and dark themes, following the system by default.
- Comments with [Disqus](https://disqus.com/), a contact form handled by [Netlify Forms](https://docs.netlify.com/forms/setup/).
- A cookie banner: Google Analytics and Disqus load only after the reader agrees, per purpose, and the choice can be changed from the footer.
- SEO: canonical URLs, Open Graph and Twitter tags, JSON-LD, RSS, sitemap, robots.txt by deploy context.
- A Content Security Policy built from the hashes of the page's own scripts.

## Getting started

Node.js 22.23.4 or later is required (see `engines` in `package.json`).

```sh
git clone https://github.com/jboinembalome/blouppy-blog.git
cd blouppy-blog
npm install
npm run dev
```

The site is served at http://localhost:4321/. The available scripts are described in [CONTRIBUTING.md](CONTRIBUTING.md).

## Project structure

```
src/
  content/blog/     the articles (one Markdown file per article)
  content/pages/    the home and About pages
  pages/            the Astro routes
  layouts/          the page layout and its <head>
  components/       the React components
  lib/              posts, site metadata, images, the Markdown pipeline
  cms/              Decap CMS previews
public/             static files (images, icons, CV, the CMS config)
scripts/            build scripts (Algolia indexing, site checks)
tests/              end-to-end tests (Playwright)
drafts/             articles not published yet
```

## Writing an article

From the CMS at `/admin/` (Netlify Identity), or by adding a Markdown file to `src/content/blog/` named `YYYY-MM-DD-slug.md`, with the same front matter as the other articles. See [`drafts/README.md`](drafts/README.md) for drafts.

## Deployment

Netlify builds `master` (and every pull request, as a deploy preview) with `npm run build` and publishes `dist/`; `netlify.toml` holds the headers and redirects. The Algolia index is pushed from production builds only.

| Variable                                             | Used for                                     |
| ---------------------------------------------------- | -------------------------------------------- |
| `GATSBY_ALGOLIA_APP_ID`, `GATSBY_ALGOLIA_SEARCH_KEY` | the search dialog (public, search-only key)  |
| `ALGOLIA_ADMIN_KEY`                                  | indexing the articles from production builds |

## License

[MIT](LICENSE)
