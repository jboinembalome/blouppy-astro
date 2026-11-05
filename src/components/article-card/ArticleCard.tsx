import React from "react";
import { Link, graphql } from "gatsby";
import PreviewCompatibleImage from "../preview-compatible-image/PreviewCompatibleImage";
import { ArticleSummary } from "../../types/graphql-queries/ArticleSummaryQuery";

export const articleSummaryFragment = graphql`
  fragment ArticleSummary on MarkdownRemark {
    id
    timeToRead
    excerpt(pruneLength: 180)
    fields {
      slug
    }
    frontmatter {
      title
      date(formatString: "MMMM DD, YYYY")
      category
      featuredimage {
        childImageSharp {
          gatsbyImageData(layout: CONSTRAINED, width: 800)
        }
      }
    }
  }
`;

interface ArticleCardProps {
  article: ArticleSummary;
  // `row` puts the cover beside the text from md up: the blog's list.
  layout?: "column" | "row";
  // The excerpt is left out where cards are small (related articles).
  showExcerpt?: boolean;
  headingLevel?: "h2" | "h3";
}

// A card in the Starter's style: a flat bordered surface that lifts a little
// on hover (DESIGN.md §6), the category as a tinted chip.
export const ArticleCard = ({ article, layout = "column", showExcerpt = true, headingLevel = "h3" }: ArticleCardProps) => {
  const { frontmatter, fields, excerpt, timeToRead } = article;
  const Heading = headingLevel;
  const isRow = layout === "row";

  return (
    <Link
      to={fields.slug}
      className={`group flex overflow-hidden rounded-xl border border-line bg-card transition duration-200 hover:-translate-y-0.5 hover:border-accent-border hover:shadow-sm ${
        isRow ? "flex-col md:flex-row" : "flex-col"
      }`}
    >
      <div className={`shrink-0 overflow-hidden border-line ${isRow ? "border-b md:w-80 md:border-b-0 md:border-r" : "border-b"}`}>
        {frontmatter.featuredimage && (
          <PreviewCompatibleImage
            className="aspect-[40/21] h-full w-full object-cover transition duration-300 group-hover:scale-[1.02]"
            imageInfo={{ image: frontmatter.featuredimage, alt: "" }}
          />
        )}
      </div>
      <div className="flex flex-1 flex-col gap-3 p-5">
        {frontmatter.category && <span className="chip self-start text-xs">{frontmatter.category}</span>}
        <Heading className="text-lg font-semibold leading-snug text-heading group-hover:text-accent">{frontmatter.title}</Heading>
        {showExcerpt && <p className="line-clamp-3 text-sm leading-relaxed text-muted">{excerpt}</p>}
        <p className="mt-auto pt-1 text-xs text-faint">
          <time>{frontmatter.date}</time>
          <span aria-hidden="true"> · </span>
          <span>{timeToRead} min read</span>
        </p>
      </div>
    </Link>
  );
};
