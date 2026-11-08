// Pushes the articles to the Algolia index the search dialog queries, after
// the build, as gatsby-plugin-algolia did. Only from the production build:
// Netlify also hands the admin key to deploy previews, which would otherwise
// replace the live index with an unmerged branch's articles.
import { readdir, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import matter from "gray-matter";
import { algoliasearch } from "algoliasearch";

const { GATSBY_ALGOLIA_APP_ID: appId, ALGOLIA_ADMIN_KEY: adminKey, CONTEXT: context } = process.env;
if (context !== "production") {
  console.log(`Algolia: not a production build (${context ?? "local"}), the search index is left as it is.`);
  process.exit(0);
}
if (!appId || !adminKey) {
  console.log("Algolia: no admin key, the search index is left as it is.");
  process.exit(0);
}

const require = createRequire(import.meta.url);
const { render } = require("../src/lib/markdown/vendor/pipeline.js");

const indexName = "Pages";
const folder = "src/content/blog";

const files = (await readdir(folder)).filter((file) => file.endsWith(".md"));
const objects = await Promise.all(
  files.map(async (file) => {
    const { data, content } = matter(await readFile(join(folder, file), "utf8"));
    const slug = `/blog/${file.slice(0, -".md".length)}/`;
    const { excerpts } = await render(content, { excerptLengths: [5000] });
    return { objectID: slug, title: data.title, slug, excerpt: excerpts[5000] };
  }),
);

const client = algoliasearch(appId, adminKey);
// The whole index is replaced, so an article removed since the last build
// leaves the search too.
await client.replaceAllObjects({ indexName, objects });
await client.setSettings({ indexName, indexSettings: { attributesToSnippet: ["excerpt:20"] } });
console.log(`Algolia: ${objects.length} articles indexed in "${indexName}".`);
