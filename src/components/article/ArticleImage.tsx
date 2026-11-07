import { IGatsbyImageData } from 'gatsby-plugin-image';
import React from 'react';
import PreviewCompatibleImage from '../preview-compatible-image/PreviewCompatibleImage';

export interface ArticleImageProps {
  image: {
    childImageSharp: {
      gatsbyImageData: IGatsbyImageData;
    };
  };
  alt: string;
}

export const ArticleImage = ({ image, alt }: ArticleImageProps) => {
  const imageInfo = {image: image, alt: alt};

  return (
    <div className="overflow-hidden rounded-xl border border-line">
        {image ? (
          <PreviewCompatibleImage
            className="z-0 object-cover object-center"
            imageInfo={imageInfo}
            loading="eager"
          />
        ) : (
          <div className="relative h-64 w-64" />
        )}
      </div>
  )
};
