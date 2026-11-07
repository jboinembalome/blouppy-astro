import { buildContext, site } from "../lib/site";

// Only production is indexed: a deploy preview or a branch deploy keeps
// crawlers out, as gatsby-plugin-robots-txt did.
export const GET = () => {
  const body =
    buildContext === "branch-deploy" || buildContext === "deploy-preview"
      ? "User-agent: *\nDisallow: /\n"
      : `User-agent: *\nSitemap: ${site.siteUrl}/sitemap-index.xml\nHost: ${site.siteUrl}\n`;
  return new Response(body, { headers: { "Content-Type": "text/plain; charset=utf-8" } });
};
