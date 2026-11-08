// The Algolia keys, inlined at build time (astro.config.mjs). Set on Netlify; a
// local build without them has no search to offer, and the client refuses to
// start without them.
export const algoliaAppId = process.env.GATSBY_ALGOLIA_APP_ID ?? "";
export const algoliaSearchKey = process.env.GATSBY_ALGOLIA_SEARCH_KEY ?? "";

export const searchConfigured = Boolean(algoliaAppId && algoliaSearchKey);
