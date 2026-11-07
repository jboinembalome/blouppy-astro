import React from "react";
import { graphql, HeadProps, PageProps } from "gatsby";
import { IndexPageTemplate } from "./index-page-template";
import { Seo } from "../components/seo/Seo";
import { ArticleSummaryEdge } from "../types/graphql-queries/ArticleSummaryQuery";

type IndexPageQuery = {
  markdownRemark: {
    frontmatter: {
      title: string;
      subheading: string;
    };
  };
  articles: {
    edges: ArticleSummaryEdge[];
  };
};

const IndexPage = ({ data }: PageProps<IndexPageQuery>) => {
  const { frontmatter } = data.markdownRemark;

  return (
    <>
      <IndexPageTemplate title={frontmatter.title} subheading={frontmatter.subheading} articles={data.articles.edges} />
    </>
  );
};

export const Head = ({ data, location }: HeadProps<IndexPageQuery>) => (
  <Seo description={data.markdownRemark.frontmatter.subheading} pathname={location.pathname} />
);

export default IndexPage;

export const pageQuery = graphql`
  query IndexPage {
    markdownRemark(frontmatter: { templateKey: { eq: "index-page" } }) {
      frontmatter {
        title
        subheading
      }
    }
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
