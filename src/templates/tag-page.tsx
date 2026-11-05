import React from "react";
import { Link, PageProps, graphql } from "gatsby";
import { kebabCase } from "lodash";
import { Seo } from "../components/seo/Seo";
import { PageHeader } from "../components/page-header/PageHeader";
import { ArticleCard } from "../components/article-card/ArticleCard";
import { ArticleSummaryEdge } from "../types/graphql-queries/ArticleSummaryQuery";

type TagPageQuery = {
  site: { siteMetadata: { siteUrl: string } };
  allMarkdownRemark: {
    totalCount: number;
    edges: ArticleSummaryEdge[];
  };
};

const TagPage = ({ data, pageContext }: PageProps<TagPageQuery, { tag: string }>) => {
  const { tag } = pageContext;
  const { totalCount, edges } = data.allMarkdownRemark;

  return (
    <>
      <Head tag={tag} siteUrl={data.site.siteMetadata.siteUrl} />
      <PageHeader
        kicker="Tag"
        title={tag}
        subtitle={`${totalCount} article${totalCount === 1 ? "" : "s"} tagged with ${tag}.`}
      />
      <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
        {edges.map(({ node }) => (
          <ArticleCard key={node.id} article={node} headingLevel="h2" />
        ))}
      </div>
      <div className="mt-12 border-t border-line pt-6">
        <Link to="/tags/" className="btn-outline btn-sm">
          Browse all tags
        </Link>
      </div>
    </>
  );
};

interface HeadProps {
  tag: string;
  siteUrl: string;
}

const Head = ({ tag, siteUrl }: HeadProps) => {
  const description = `Article(s) tagged with ${tag}`;
  const url = `${siteUrl}/tags/${kebabCase(tag)}`;

  return <Seo title={tag} description={description} url={url} />;
};

export default TagPage;

export const tagPageQuery = graphql`
  query TagPage($tag: String) {
    site {
      siteMetadata {
        siteUrl
      }
    }
    allMarkdownRemark(
      limit: 1000
      sort: { frontmatter: { date: DESC } }
      filter: { frontmatter: { tags: { in: [$tag] } } }
    ) {
      totalCount
      edges {
        node {
          ...ArticleSummary
        }
      }
    }
  }
`;
