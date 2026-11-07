import { ImageQuery } from "./ImageQuery";

type SiteMetadataType = {
  siteUrl: string;
};

type FieldsType = {
  slug: string;
};

type FrontmatterType = {
  title: string;
  date: string;
  description: string;
  category: string;
  topic: string;
  tags: string[];
  featuredpost: boolean;
  featuredlink: string;
  featuredauthor: string;
  featuredimage: ImageQuery;
  author: string;
  authorimage: ImageQuery;
};

export type BlogPostQuery = {
  site: {
    siteMetadata: SiteMetadataType;
  };
  markdownRemark: {
    html: string;
    timeToRead: number;
    tableOfContents: string;
    excerpt: string;
    id: string;
    fields: FieldsType;
    frontmatter: FrontmatterType;
  };
};