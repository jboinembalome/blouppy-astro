import React from 'react';
import { CameraIcon } from '@heroicons/react/24/solid';

export interface ArticleImageCaptionProps {
  imageLink: string;
  imageCreator: string;
  source?: string;
}

export const ArticleImageCaption = ({ imageLink, imageCreator, source }: ArticleImageCaptionProps) => {

  return (
    <figcaption className="flex items-center text-sm text-muted">
      <CameraIcon className="h-4 w-4 flex-none text-faint" aria-hidden="true" />
      <span className="ml-2">
        Photo by{" "}
        <a href={imageLink} target="_blank" rel="noopener noreferrer" className="underline hover:text-heading">
          {imageCreator}
        </a>{" "}
        {source && (
          <>
            on{" "}
            <a href={source} target="_blank" rel="noopener noreferrer" className="underline hover:text-heading">
              Unsplash
            </a>
          </>
        )}
      </span>
    </figcaption>
  )
};
