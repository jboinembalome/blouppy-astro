import React from "react";
import { Seo } from "../../components/seo/Seo";
import { PageProps, graphql } from "gatsby";
import { TagsPageQuery } from "../../types/graphql-queries";
import { TagWithCount } from "../../components/tag";
import { PageHeader } from "../../components/page-header/PageHeader";

const TagsPage = ({ data }: PageProps<TagsPageQuery>) => {
  const { allMarkdownRemark: { group } } = data;

  return (
    <>
      <Head siteUrl={data.site.siteMetadata.siteUrl} />
      <PageHeader kicker="Blog" title="Tags" subtitle="Every topic the articles cover, with how many posts each one has." />
      <ul className="flex flex-wrap gap-2">
        {[...group]
          .sort((a, b) => b.totalCount - a.totalCount)
          .map((tag) => (
            <li key={tag.fieldValue}>
              <TagWithCount tag={tag} />
            </li>
          ))}
      </ul>
    </>
  );
};

interface HeadProps {
  siteUrl: string;
}

const Head = ({ siteUrl }: HeadProps) => (
  <Seo
    title="Tags"
    description="List of tags for all articles."
    url={`${siteUrl}/tags`}
  />
);

export default TagsPage;

export const tagPageQuery = graphql`
  query TagsPage {
    site {
      siteMetadata {
        siteUrl
      }
    }
    allMarkdownRemark(limit: 1000) {
      group(field: { frontmatter: { tags: SELECT } }) {
        fieldValue
        totalCount
      }
    }
  }
`;
