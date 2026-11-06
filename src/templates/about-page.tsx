import React from 'react'
import { HeadProps, PageProps, graphql } from 'gatsby'
import { AboutPageTemplate } from './about-page-template'
import { Seo } from "../components/seo/Seo"
import { ImageDataLike, getSrc } from "gatsby-plugin-image"
import { AboutPageQuery } from '../types/graphql-queries';

const AboutPage = ({ data }: PageProps<AboutPageQuery>) => {
  const { frontmatter, html } = data.markdownRemark

  return (
    <>
      <AboutPageTemplate
        title={frontmatter.title}
        aboutimage={frontmatter.aboutimage}
        content={html}
      />
    </>
  )
}

export const Head = ({ data, location }: HeadProps<AboutPageQuery>) => {
  const { frontmatter } = data.markdownRemark
  return (
    <Seo
      title={frontmatter.title}
      description={frontmatter.description}
      pathname={location.pathname}
      image={getSrc(frontmatter.aboutimage as ImageDataLike)}
      imageAlt={`Portrait of ${data.site.siteMetadata.author.name}`}
    />
  )
}

export default AboutPage

export const aboutPageQuery = graphql`
  query AboutPage($id: String!) {
    site {
      siteMetadata {
        author {
          name
        }
        siteUrl
      }
    }
    markdownRemark(id: { eq: $id }) {
      html
      frontmatter {
        title
        description
        aboutimage {
          childImageSharp {
            gatsbyImageData(layout: FULL_WIDTH)
          }
        }
      }
    }
  }
`
