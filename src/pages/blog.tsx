import React from "react";
import { HeadProps, PageProps, graphql } from "gatsby";
import { ArticleIndex } from "../components/article-index/ArticleIndex";
import { PageHeader } from "../components/page-header/PageHeader";
import { Seo } from "../components/seo/Seo";
import { ArticleSummaryEdge } from "../types/graphql-queries/ArticleSummaryQuery";

type ArticlesPageQuery = {
  articles: { edges: ArticleSummaryEdge[] };
};

const description = "Every article, newest first: architecture, security, messaging, data, testing, front end, C# & .NET and tooling.";

const ArticlesPage = ({ data }: PageProps<ArticlesPageQuery>) => (
  <>
    <PageHeader title="Articles" subtitle={description} />
    <ArticleIndex articles={data.articles.edges} />
  </>
);

export const Head = ({ location }: HeadProps) => <Seo title="Articles" description={description} pathname={location.pathname} />;

export default ArticlesPage;

export const query = graphql`
  query ArticlesPage {
    articles: allMarkdownRemark(
      sort: { frontmatter: { date: DESC } }
      filter: { frontmatter: { templateKey: { eq: "blog-post" } } }
    ) {
      edges {
        node {
          ...ArticleSummary
        }
      }
    }
  }
`;
