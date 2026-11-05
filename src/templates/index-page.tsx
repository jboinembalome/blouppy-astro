import React from "react";
import { graphql, PageProps } from "gatsby";
import { IndexPageTemplate } from "./index-page-template";
import { Seo } from "../components/seo/Seo";
import { HomePageQuery } from "../types/graphql-queries";

const IndexPage = ({ data: { markdownRemark: { frontmatter } } }: PageProps<HomePageQuery>) => {
  return (
    <>
      <Head description={frontmatter.mainpitch.description} />
      <IndexPageTemplate
        title={frontmatter.title}
        heading={frontmatter.heading}
        subheading={frontmatter.subheading}
        mainpitch={frontmatter.mainpitch}
      />
    </>
  );
};

interface HeadProps {
  description: string;
}

const Head = ({ description }: HeadProps) => {
  const headDescription = `The personal website of Jimmy Boinembalome. ${description}`;

  return <Seo description={headDescription} />;
};

export default IndexPage;

export const pageQuery = graphql`
  query IndexPage {
    markdownRemark(frontmatter: { templateKey: { eq: "index-page" } }) {
      frontmatter {
        title
        heading
        subheading
        mainpitch {
          title
          description
        }
      }
    }
  }
`;
