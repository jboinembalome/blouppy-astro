import React from "react";
import { HeadProps, PageProps, graphql } from "gatsby";
import { BlogPostTemplate } from "./blog-post-template";
import { Seo } from "../components/seo/Seo";
import { ImageDataLike, getSrc } from "gatsby-plugin-image";
import { BlogPostQuery } from "../types/graphql-queries";
import { ArticleSummaryEdge } from "../types/graphql-queries/ArticleSummaryQuery";
import { topicByName } from "../constants/topics";

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
        topic={post.frontmatter.topic}
        tags={post.frontmatter.tags}
        title={post.frontmatter.title}
        tableOfContents={post.tableOfContents}
        related={related}
      />
    </>
  );
};

export const Head = ({ data, location }: HeadProps<BlogPostPageQuery>) => {
  const { frontmatter, fields } = data.markdownRemark;
  const { siteUrl, author } = data.site.siteMetadata;
  // A shared link shows the topic's image (static/img/topics); a post without a
  // topic falls back to its own cover, if it has one.
  const topic = topicByName(frontmatter.topic);
  const image = topic
    ? `/img/topics/${topic.slug}.jpg`
    : frontmatter.featuredimage
      ? getSrc(frontmatter.featuredimage as ImageDataLike)
      : undefined;
  const structuredData = {
    "@context": "https://schema.org",
    "@type": "BlogPosting",
    headline: frontmatter.title,
    description: frontmatter.description,
    datePublished: frontmatter.isoDate,
    author: { "@type": "Person", name: author.name, url: `${siteUrl}/about/` },
    image: image ? `${siteUrl}${image}` : undefined,
    url: `${siteUrl}${fields.slug}`,
    mainEntityOfPage: `${siteUrl}${fields.slug}`,
    keywords: frontmatter.tags?.join(", "),
  };

  return (
    <Seo title={frontmatter.title} description={frontmatter.description} pathname={location.pathname} image={image} type="article">
      <meta property="article:published_time" content={frontmatter.isoDate} />
      {frontmatter.tags?.map((tag) => <meta key={tag} property="article:tag" content={tag} />)}
      <script type="application/ld+json">{JSON.stringify(structuredData)}</script>
    </Seo>
  );
};

export default BlogPost;

export const pageQuery = graphql`
  query BlogPost($id: String!, $relatedTags: [String]) {
    site {
      siteMetadata {
        siteUrl
        author {
          name
        }
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
        isoDate: date
        title
        description
        category
        topic
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
