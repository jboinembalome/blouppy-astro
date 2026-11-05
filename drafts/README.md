# Drafts

The site has no draft flag: every Markdown file under `src/pages/` is sourced by
`gatsby-source-filesystem`, turned into a page, listed on `/blog`, tagged and indexed
by Algolia. This folder sits outside `src/pages/`, so nothing in it is built or
published.

Drafts use the same front matter as `src/pages/blog/*.md`.

## Publishing a draft

1. Add its cover image to `static/img/` under the name set in `featuredimage`
   (and `featuredauthor` / `featuredlink` if it comes from Unsplash).
2. Set `date` to the publication date and rename the file to match
   (`YYYY-MM-DD-slug.md`): the slug becomes the URL.
3. Move it to `src/pages/blog/`.
4. Run `npm run build` and check the page.
