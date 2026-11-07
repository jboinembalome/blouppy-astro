# Drafts

The site has no draft flag: every Markdown file under `src/content/blog/` is turned
into a page, listed on `/blog`, tagged and indexed by Algolia. This folder sits
outside `src/content/`, so nothing in it is built or published.

Drafts use the same front matter as `src/content/blog/*.md`.

## Publishing a draft

1. Add its cover image to `public/img/` under the name set in `featuredimage`
   (and `featuredauthor` / `featuredlink` if it comes from Unsplash).
2. Set `date` to the publication date and rename the file to match
   (`YYYY-MM-DD-slug.md`): the slug becomes the URL.
3. Move it to `src/content/blog/`.
4. Run `npm run build` and check the page.
