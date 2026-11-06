// The fields of the `ArticleSummary` fragment (components/article-card), which
// every list of articles queries: the home page, a tag, related posts.
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
    description: string | null;
    topic: string | null;
    illustration: number | null;
    tags: string[] | null;
  };
};

export type ArticleSummaryEdge = {
  node: ArticleSummary;
};
