import React from 'react'
import { IGatsbyImageData } from 'gatsby-plugin-image'
import { HTMLContent } from '../components/layout/Content'
import { ArticleImageCaption } from '../components/article'
import PreviewCompatibleImage from '../components/preview-compatible-image/PreviewCompatibleImage'

interface AboutPageTemplateProps {
  title: string;
  aboutimage: {
    childImageSharp: {
      gatsbyImageData: IGatsbyImageData;
    };
  };
  content: string;
}

// The text at a reading measure, the portrait beside it rather than above it:
// on a phone the photo comes first but stays a modest size.
export const AboutPageTemplate = ({ title, aboutimage, content }: AboutPageTemplateProps) => {

  return (
    <div className="mx-auto grid max-w-5xl gap-10 md:grid-cols-[minmax(0,1fr)_16rem] md:gap-14">
      {aboutimage && (
        <figure className="mx-auto flex w-full max-w-[16rem] flex-col gap-3 md:order-2 md:mx-0 md:pt-16">
          <div className="overflow-hidden rounded-xl border border-line">
            <PreviewCompatibleImage className="aspect-[4/5] object-cover" imageInfo={{ image: aboutimage, alt: "Portrait of Jimmy Boinembalome" }} loading="eager" />
          </div>
          <ArticleImageCaption imageLink="https://www.instagram.com/zenasiart/?hl=fr" imageCreator="Asia Zeni" />
        </figure>
      )}
      <div className="min-w-0 md:order-1">
        <h1 className="mb-6 text-3xl font-extrabold tracking-tight text-heading sm:text-4xl">{title}</h1>
        <HTMLContent className="article-body prose prose-blouppy max-w-none lg:prose-lg" content={content} />
      </div>
    </div>
  )
}
