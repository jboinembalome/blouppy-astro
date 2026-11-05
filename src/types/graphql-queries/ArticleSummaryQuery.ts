import { ImageQuery } from "./ImageQuery";

// The fields of the `ArticleSummary` fragment (components/article-card), which
// every list of articles queries: the home page, the blog, a tag, related posts.
export type ArticleSummary = {
  id: string;
  timeToRead: number;
  excerpt: string;
  fields: {
    slug: string;
  };
  frontmatter: {
    title: string;
    date: string;
    category: string;
    featuredimage: ImageQuery;
  };
};

export type ArticleSummaryEdge = {
  node: ArticleSummary;
};
