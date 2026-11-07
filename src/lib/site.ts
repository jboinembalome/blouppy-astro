// What gatsby-config.ts called siteMetadata. The site's URL follows Netlify's
// build context: production uses the site's own URL, a deploy preview or a
// branch deploy its own address, so canonical and Open Graph URLs point where
// the page actually is.
const defaultSiteUrl = "https://blouppy.com";
const {
  NODE_ENV,
  URL: netlifySiteUrl = defaultSiteUrl,
  DEPLOY_PRIME_URL: netlifyDeployUrl = netlifySiteUrl,
  CONTEXT: netlifyContext = NODE_ENV,
} = process.env;

export const buildContext = netlifyContext;
export const isProductionContext = netlifyContext === "production";

export const site = {
  title: "Blouppy",
  author: {
    name: "Jimmy Boinembalome",
    summary: "Software engineer from France, writing about software engineering.",
  },
  description: "Articles on software engineering: architecture, security, testing, back end and front end.",
  siteUrl: isProductionContext ? netlifySiteUrl : netlifyDeployUrl,
  social: {
    twitter: "@JBoinembalome",
    twitterUrl: "https://twitter.com/JBoinembalome",
    linkedinUrl: "https://fr.linkedin.com/in/jimmy-boinembalome-87281a189",
    githubUrl: "https://github.com/jboinembalome",
  },
  analyticsId: "G-RDNQF6X1VT",
  disqusShortname: "blouppy",
} as const;

export type Site = typeof site;
