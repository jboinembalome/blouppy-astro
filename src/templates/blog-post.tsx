import React from "react";
import { PageProps, graphql } from "gatsby";
import { BlogPostTemplate } from "./blog-post-template";
import { Seo } from "../components/seo/Seo";
import { ImageDataLike, getSrc } from "gatsby-plugin-image";
import { BlogPostQuery } from "../types/graphql-queries";
import { ArticleSummaryEdge } from "../types/graphql-queries/ArticleSummaryQuery";

type BlogPostPageQuery = BlogPostQuery & {
  related: { edges: (ArticleSummaryEdge & { node: { frontmatter: { tags: string[] } } })[] };
};

// The candidates share at least one tag with the post; the three sharing the
// most come first, the newest breaking ties (the query already sorts by date).
const pickRelated = (candidates: BlogPostPageQuery["related"]["edges"], tags: string[]) =>
  candidates
    .map((edge, index) => ({
      edge,
      index,
      shared: edge.node.frontmatter.tags.filter((tag) => tags.includes(tag)).length,
    }))
    .sort((a, b) => b.shared - a.shared || a.index - b.index)
    .slice(0, 3)
    .map(({ edge }) => edge);

const BlogPost = ({ data, pageContext }: PageProps<BlogPostPageQuery, { relatedTags: string[] }>) => {
  const { markdownRemark: post } = data;
  const readingTime = `${post.timeToRead} min read`;
  const related = pickRelated(data.related.edges, pageContext.relatedTags ?? []);

  return (
    <>
      <Head
        title={post.frontmatter.title}
        description={post.frontmatter.description}
        slug={post.fields.slug}
        siteUrl={data.site.siteMetadata.siteUrl}
        featuredimage={post.frontmatter.featuredimage}
      />
      <BlogPostTemplate
        content={post.html}
        description={post.frontmatter.description}
        author={post.frontmatter.author}
        authorimage={post.frontmatter.authorimage}
        date={post.frontmatter.date}
        imageCreator={post.frontmatter.featuredauthor}
        imageLink={post.frontmatter.featuredlink}
        image={post.frontmatter.featuredimage}
        slug={post.fields.slug}
        readingTime={readingTime}
        category={post.frontmatter.category}
        tags={post.frontmatter.tags}
        title={post.frontmatter.title}
        tableOfContents={post.tableOfContents}
        related={related}
      />
    </>
  );
};

interface HeadProps {
  title: string;
  description: string;
  slug: string;
  siteUrl: string;
  featuredimage: ImageDataLike;
}

const Head = ({ title, description, slug, siteUrl, featuredimage }: HeadProps) => {
  return (
    <Seo
      title={title}
      description={description}
      url={`${siteUrl}${slug}`}
    >
      <meta
        name="image"
        content={`${siteUrl}${getSrc(featuredimage)}`}
      />
      <meta property="og:image:alt" content={title} />
      <meta
        property="og:image"
        content={`${siteUrl}${getSrc(featuredimage)}`}
      />
    </Seo>
  );
};

export default BlogPost;

export const pageQuery = graphql`
  query BlogPost($id: String!, $relatedTags: [String]) {
    site {
      siteMetadata {
        siteUrl
      }
    }
    markdownRemark(id: { eq: $id }) {
      id
      html
      timeToRead
      tableOfContents(maxDepth: 3)
      fields {
        slug
      }
      frontmatter {
        date(formatString: "MMMM DD, YYYY")
        title
        description
        category
        tags
        featuredauthor
        featuredlink
        featuredimage {
          childImageSharp {
            gatsbyImageData(layout: FULL_WIDTH)
          }
        }
        author
        authorimage {
          childImageSharp {
            gatsbyImageData(layout: FULL_WIDTH)
          }
        }
      }
    }
    related: allMarkdownRemark(
      filter: {
        id: { ne: $id }
        frontmatter: { templateKey: { eq: "blog-post" }, tags: { in: $relatedTags } }
      }
      sort: { frontmatter: { date: DESC } }
      limit: 30
    ) {
      edges {
        node {
          ...ArticleSummary
          frontmatter {
            tags
          }
        }
      }
    }
  }
`;
