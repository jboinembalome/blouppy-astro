// @ts-check
import { defineConfig } from "astro/config";
import react from "@astrojs/react";
import sitemap from "@astrojs/sitemap";
import tailwindcss from "@tailwindcss/vite";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";

// The same URL logic as src/lib/site.ts (Netlify's build context), needed here
// before any module of the site is loaded.
const defaultSiteUrl = "https://blouppy.com";
const {
  NODE_ENV,
  URL: netlifySiteUrl = defaultSiteUrl,
  DEPLOY_PRIME_URL: netlifyDeployUrl = netlifySiteUrl,
  CONTEXT: netlifyContext = NODE_ENV,
} = process.env;
const siteUrl = netlifyContext === "production" ? netlifySiteUrl : netlifyDeployUrl;

// The page after the contact form, the CMS and the 404 page are no one's landing page.
const notInSitemap = ["/contact/thanks/", "/admin/", "/404/", "/404.html"];

export default defineConfig({
  site: siteUrl,
  // Every page is built as <path>/index.html and linked with a trailing slash,
  // the URLs the Gatsby build published.
  trailingSlash: "always",
  build: { format: "directory" },
  // Astro 7 strips whitespace between inline elements by default (React's
  // rules), which would glue words of the articles together.
  compressHTML: true,
  // A Content Security Policy in a <meta> of every page: scripts only from the
  // site, the inline ones Astro hashes, and the third parties the pages load.
  // Styles stay open, as React and the Markdown write style attributes; Giscus
  // adds its own stylesheet.
  security: {
    csp: {
      directives: ["object-src 'none'", "base-uri 'self'", "form-action 'self'"],
      scriptDirective: {
        resources: [
          "'self'",
          "https://www.googletagmanager.com",
          "https://cdnjs.buymeacoffee.com",
          "https://giscus.app",
        ],
      },
      styleDirective: { resources: ["'self'", "'unsafe-inline'", "https://giscus.app"] },
    },
  },
  prefetch: { prefetchAll: false, defaultStrategy: "hover" },
  integrations: [
    react(),
    // After the build: the not-found page at /404/ as well as /404.html (as
    // Gatsby published it), and the CMS without the CSP.
    {
      name: "post-build",
      hooks: {
        "astro:build:done": async ({ dir }) => {
          const notFound = new URL("404.html", dir);
          await mkdir(new URL("404/", dir), { recursive: true });
          await copyFile(notFound, new URL("404/index.html", dir));
          // Each copy names its own URL as canonical, as Gatsby's two did.
          const html = await readFile(notFound, "utf8");
          await writeFile(notFound, html.replaceAll(`${siteUrl}/404/"`, `${siteUrl}/404.html"`));
          // Decap CMS evaluates code, injects its own scripts and loads Netlify
          // Identity: /admin/ goes without the site's Content Security Policy.
          const admin = new URL("admin/index.html", dir);
          const adminHtml = await readFile(admin, "utf8");
          await writeFile(admin, adminHtml.replace(/<meta http-equiv="content-security-policy"[^>]*>/, ""));
        },
      },
    },
    sitemap({
      changefreq: "daily",
      priority: 0.7,
      filter: (page) => !notInSitemap.some((path) => new URL(page).pathname === path),
    }),
  ],
  vite: {
    plugins: [tailwindcss()],
    // The Algolia keys keep the names Netlify already has (Gatsby exposed the
    // GATSBY_ prefix to the browser): the app id and the search-only key are
    // public by design; the admin key is read by scripts/algolia-index.mjs only.
    define: {
      "process.env.GATSBY_ALGOLIA_APP_ID": JSON.stringify(process.env.GATSBY_ALGOLIA_APP_ID || ""),
      "process.env.GATSBY_ALGOLIA_SEARCH_KEY": JSON.stringify(process.env.GATSBY_ALGOLIA_SEARCH_KEY || ""),
    },
  },
});
