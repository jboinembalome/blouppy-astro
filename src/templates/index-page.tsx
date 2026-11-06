import React from "react";
import { graphql, PageProps } from "gatsby";
import { IndexPageTemplate } from "./index-page-template";
import { Seo } from "../components/seo/Seo";
import { HomePageQuery } from "../types/graphql-queries";

const IndexPage = ({ data: { markdownRemark: { frontmatter } } }: PageProps<HomePageQuery>) => {
  return (
    <>
      <Head description={frontmatter.subheading} />
      <IndexPageTemplate
        title={frontmatter.title}
        heading={frontmatter.heading}
        subheading={frontmatter.subheading}
      />
    </>
  );
};

interface HeadProps {
  description: string;
}

const Head = ({ description }: HeadProps) => {
  return <Seo description={description} />;
};

export default IndexPage;

export const pageQuery = graphql`
  query IndexPage {
    markdownRemark(frontmatter: { templateKey: { eq: "index-page" } }) {
      frontmatter {
        title
        heading
        subheading
      }
    }
  }
`;
