require("dotenv").config()
import type { GatsbyConfig } from "gatsby";

const defaultSiteUrl = 'https://blouppy.com'
const {
  NODE_ENV,
  URL: NETLIFY_SITE_URL = defaultSiteUrl,
  DEPLOY_PRIME_URL: NETLIFY_DEPLOY_URL = NETLIFY_SITE_URL,
  CONTEXT: NETLIFY_ENV = NODE_ENV,
} = process.env

const isNetlifyProduction = NETLIFY_ENV === 'production'
const siteUrl = isNetlifyProduction ? NETLIFY_SITE_URL : NETLIFY_DEPLOY_URL
const config: GatsbyConfig = {
  siteMetadata: {
    title: `Blouppy`,
    author: {
      name: `Jimmy Boinembalome`,
      summary: `Software engineer from France, writing about software engineering.`,
    },
    description: `Articles on software engineering: architecture, security, testing, back end and front end.`,
    siteUrl: siteUrl,
    canonicalUrl: siteUrl,
    social: {
      twitter: `@JBoinembalome`,
      twitterUrl: `https://twitter.com/JBoinembalome`,
      linkedinUrl: `https://fr.linkedin.com/in/jimmy-boinembalome-87281a189`,
      githubUrl: `https://github.com/jboinembalome`
    },
  },
  plugins: [
    {
      resolve: 'gatsby-plugin-robots-txt',
      options: {
        resolveEnv: () => NETLIFY_ENV,
        env: {
          production: {
            policy: [{ userAgent: '*' }],
          },
          'branch-deploy': {
            policy: [{ userAgent: '*', disallow: ['/'] }],
            sitemap: null,
            host: null,
          },
          'deploy-preview': {
            policy: [{ userAgent: '*', disallow: ['/'] }],
            sitemap: null,
            host: null,
          },
        },
      },
    },
    {
      resolve: 'gatsby-plugin-sitemap',
      options: {
        // The page after the contact form, and the CMS, are no one's landing page.
        excludes: ['/contact/thanks/', '/admin/', '/dev-404-page/', '/404/', '/404.html'],
      },
    },
    {
      resolve: 'gatsby-plugin-feed',
      options: {
        feeds: [
          {
            serialize: ({ query: { site, allMarkdownRemark } }: any) =>
              allMarkdownRemark.nodes.map((node: any) => {
                const url = `${site.siteMetadata.siteUrl}${node.fields.slug}`
                return {
                  title: node.frontmatter.title,
                  description: node.frontmatter.description || node.excerpt,
                  date: node.frontmatter.date,
                  url,
                  guid: url,
                  categories: [node.frontmatter.topic, ...(node.frontmatter.tags ?? [])].filter(Boolean),
                  custom_elements: [{ 'content:encoded': node.html }],
                }
              }),
            query: `
              {
                allMarkdownRemark(
                  sort: { frontmatter: { date: DESC } }
                  filter: { frontmatter: { templateKey: { eq: "blog-post" } } }
                ) {
                  nodes {
                    excerpt
                    html
                    fields { slug }
                    frontmatter { title description date topic tags }
                  }
                }
              }
            `,
            output: '/rss.xml',
            title: 'Blouppy',
            description: `Articles on software engineering: architecture, security, testing, back end and front end.`,
          },
        ],
      },
    },
    'gatsby-plugin-catch-links',
    'gatsby-plugin-sass',
    {
      // keep as first gatsby-source-filesystem plugin for gatsby image support
      resolve: 'gatsby-source-filesystem',
      options: {
        path: `${__dirname}/static/img`,
        name: 'uploads',
      },
    },
    {
      resolve: 'gatsby-source-filesystem',
      options: {
        path: `${__dirname}/src/pages`,
        name: 'pages',
      },
    },
    {
      resolve: `gatsby-plugin-sharp`,
      options: {
        defaults: {
          placeholder: `none`,
          backgroundColor: `transparent`         
        },
      },
    },
    'gatsby-transformer-sharp',
    'gatsby-plugin-image',
    {
      resolve: `gatsby-plugin-manifest`,
      options: {
        start_url: `/`,
        name: `Blouppy`,
        short_name: `blouppy`,
        description: `Articles on software engineering: architecture, security, testing, back end and front end.`,
        background_color: `#ffffff`,
        theme_color: `#676dcf`,
        display: `standalone`,
        icon: 'static/img/logo.png', // This path is relative to the root of the site.
      },
    },
    {
      resolve: `gatsby-plugin-disqus`,
      options: {
        shortname: `blouppy`
      }
    },
    {
      resolve: 'gatsby-transformer-remark',
      options: {
        plugins: [
          {
            resolve: 'gatsby-remark-relative-images',
            options: {
              name: 'uploads',
            },
          },
          {
            resolve: 'gatsby-remark-images',
            options: {
              // It's important to specify the maxWidth (in pixels) of
              // the content container as this plugin uses this as the
              // base for generating different widths of each image.
              maxWidth: 2048,
              backgroundColor: 'transparent'
            },
          },
          {
            resolve: 'gatsby-remark-copy-linked-files',
            options: {
              destinationDir: 'static',
            },
          },
          {
            // Anchors on h2/h3, which the article's table of contents links to.
            resolve: 'gatsby-remark-autolink-headers',
            options: {
              elements: ['h2', 'h3'],
              isIconAfterHeader: true,
              className: 'anchor',
            },
          },
          {
            resolve: 'gatsby-remark-code-buttons',
            options: {
              buttonText: `Copy`,
              tooltipText: `Copy to clipboard`,
              toasterText: 'Copied! ✅',
              toasterDuration: 2000
            }
          },
          {
            resolve: `gatsby-remark-prismjs`,
            options: {
              inlineCodeMarker: '›',
              showLineNumbers: true,
              languageExtensions: [
                {
                  language: "aspnet",
                  definition: {
                    superscript_types: /(SuperType)/,
                  },
                  insertBefore: {
                    function: {
                      superscript_keywords: /(superif|superelse)/,
                    },
                  },
                },
              ],
              // Customize the prompt used in shell output
              // Values below are default
              prompt: {
                user: "root",
                host: "localhost",
                global: false,
              },
              // By default the HTML entities <>&'" are escaped.
              // Add additional HTML escapes by providing a mapping
              // of HTML entities and their escape value IE: { '}': '&#123;' }
              escapeEntities: {},
            },
          },
        ],
      },
    },
    // The search index is pushed only where its admin key is set (Netlify's
    // production build): a local build or a deploy preview goes without.
    ...(process.env.ALGOLIA_ADMIN_KEY
      ? [
          {
            resolve: `gatsby-plugin-algolia`,
            options: {
              appId: process.env.GATSBY_ALGOLIA_APP_ID,
              apiKey: process.env.ALGOLIA_ADMIN_KEY,
              queries: require("./src/utils/algolia-queries"),
            },
          },
        ]
      : []),
    {
      resolve: 'gatsby-plugin-decap-cms',
      options: {
        modulePath: `${__dirname}/src/cms/cms.ts`,
      },
    },
    {
      resolve: 'gatsby-plugin-postcss',
    },
    // must be after other CSS plugins
    'gatsby-plugin-netlify', // make sure to keep it last in the array
    // The site used to install gatsby-plugin-offline's service worker, which
    // served the previous deploy to returning readers. This one unregisters it.
    'gatsby-plugin-remove-serviceworker',
  ],
}

export default config