import rss from "@astrojs/rss";
import { getPosts } from "../lib/posts";
import { renderMarkdown } from "../lib/markdown";
import { site } from "../lib/site";

// The feed gatsby-plugin-feed published: every post, newest first, in full.
export const GET = async () => {
  const items = await Promise.all(
    getPosts().map(async (post) => {
      const { html, excerpts } = await renderMarkdown(post.body);
      const { title, description, date, topic, tags } = post.frontmatter;
      const url = `${site.siteUrl}${post.slug}`;
      return {
        title,
        description: description || excerpts[140],
        pubDate: new Date(date),
        link: url,
        categories: [topic, ...(tags ?? [])].filter((category): category is string => Boolean(category)),
        content: html,
        customData: `<guid isPermaLink="false">${url}</guid>`,
      };
    })
  );

  return rss({
    title: site.title,
    description: site.description,
    site: site.siteUrl,
    xmlns: { dc: "http://purl.org/dc/elements/1.1/", content: "http://purl.org/rss/1.0/modules/content/" },
    items,
  });
};
