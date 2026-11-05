import { useStaticQuery, graphql } from "gatsby";
import { ArticleSummaryEdge } from "../types/graphql-queries/ArticleSummaryQuery";

type LatestArticlesQuery = {
  latest: { edges: ArticleSummaryEdge[] };
  topics: { group: { fieldValue: string; totalCount: number }[] };
};

// The home page's two lists: the six newest posts, and the tags the posts use
// most, which make the topic chips. "Development" is on every post, so it says
// nothing about what to read and is left out.
export const useLatestArticles = () => {
  const data: LatestArticlesQuery = useStaticQuery(graphql`
    query LatestArticles {
      latest: allMarkdownRemark(
        sort: { frontmatter: { date: DESC } }
        filter: { frontmatter: { templateKey: { eq: "blog-post" } } }
        limit: 6
      ) {
        edges {
          node {
            ...ArticleSummary
          }
        }
      }
      topics: allMarkdownRemark(filter: { frontmatter: { templateKey: { eq: "blog-post" } } }) {
        group(field: { frontmatter: { tags: SELECT } }) {
          fieldValue
          totalCount
        }
      }
    }
  `);

  const topics = [...data.topics.group]
    .filter((tag) => tag.fieldValue !== "Development")
    .sort((a, b) => b.totalCount - a.totalCount)
    .slice(0, 12);

  return { articles: data.latest.edges, topics };
};
