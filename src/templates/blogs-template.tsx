import React from 'react'
import { PageProps, graphql } from 'gatsby'
import { Seo } from "../components/seo/Seo"
import { Pagination } from '../components/pagination'
import { PageHeader } from '../components/page-header/PageHeader'
import { ArticleCard } from '../components/article-card/ArticleCard'
import { ArticleSummaryEdge } from '../types/graphql-queries/ArticleSummaryQuery'
import { useSiteMetadata } from '../hooks/useSiteMetadata';

type BlogsPageQuery = {
  allMarkdownRemark: {
    edges: ArticleSummaryEdge[];
    totalCount: number;
  };
};

type BlogsPageContext = {
  previousPagePath: string;
  nextPagePath: string;
  humanPageNumber: number;
  numberOfPages: number;
};

const BlogsPage = ({ data, pageContext }: PageProps<BlogsPageQuery, BlogsPageContext>) => {
  const { previousPagePath, nextPagePath, humanPageNumber, numberOfPages } = pageContext;
  const articles = data.allMarkdownRemark.edges;

  return (
    <>
      <Head />
      <PageHeader
        kicker="Blog"
        title="Articles"
        subtitle="ASP.NET Core, Angular and SaaS architecture: patterns, trade-offs and traps, each one drawn from real code."
      />
      <section className="flex flex-col gap-6">
        {articles.map(({ node }) => (
          <ArticleCard key={node.id} article={node} layout="row" headingLevel="h2" />
        ))}
      </section>
      <Pagination
        previousPagePath={previousPagePath}
        nextPagePath={nextPagePath}
        humanPageNumber={humanPageNumber}
        numberOfPages={numberOfPages}
        previousPageButtonText="Newer"
        nextPageButtonText="Older"
      />
    </>
  )
}

const Head = () => {
  const { siteUrl } = useSiteMetadata();
  const description = "Articles on ASP.NET Core, Angular and SaaS architecture.";

  return <Seo title="Blog" description={description} url={`${siteUrl}/blog`} />
};

export default BlogsPage

export const pageQuery = graphql`
  query BlogsPage($skip: Int, $limit: Int) {
    allMarkdownRemark(
      sort: {frontmatter: {date: DESC}}
      skip: $skip
      limit: $limit
      filter: {frontmatter: {templateKey: {eq: "blog-post"}}}
    ) {
      totalCount
      edges {
        node {
          ...ArticleSummary
        }
      }
    }
  }
`
