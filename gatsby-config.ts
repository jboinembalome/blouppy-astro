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
      summary: `👋 Hi, I am @jboinembalome. I am design and development engineer from France with a passion for application development.`,
    },
    description: `Practical software engineering articles, written from the code of a real SaaS.`,
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
    'gatsby-plugin-sitemap',
    'gatsby-plugin-react-helmet',
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
        description:
          'The personal website of Jimmy Boinembalome. Blouppy is a place where you can get information about tips, best practices, technologies around Microsoft such as .NET Core, WPF, ASP.NET Core but also about other topics. You can also find information about the creator of Blouppy if you wish.',
        background_color: `#ffffff`,
        theme_color: `#b5bfeb`,
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
      resolve: `gatsby-plugin-google-gtag`,
      options: {
        // You can add multiple tracking ids and a pageview event will be fired for all of them.
        trackingIds: [
          "G-RDNQF6X1VT", // Google Analytics / GA
        ],
      },
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
    {
      resolve: `gatsby-plugin-algolia`,
      options: {
        appId: process.env.GATSBY_ALGOLIA_APP_ID,
        apiKey: process.env.ALGOLIA_ADMIN_KEY,
        queries: require("./src/utils/algolia-queries")
      },
    },
    {
      resolve: 'gatsby-plugin-netlify-cms',
      options: {
        modulePath: `${__dirname}/src/cms/cms.ts`,
      },
    },
    {
      resolve: 'gatsby-plugin-postcss',
    },
    // must be after other CSS plugins
    'gatsby-plugin-netlify', // make sure to keep it last in the array
    /* Must be placed at the end */
    `gatsby-plugin-offline`,
  ],
}

export default config