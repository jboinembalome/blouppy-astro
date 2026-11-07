import React from "react";
import PreviewCompatibleImage from "../preview-compatible-image/PreviewCompatibleImage";
import { GithubIcon } from "../icons/svg/social/Icons";
import { ImageDataLike } from "gatsby-plugin-image";

interface ArticleInformationProps {
  author: string;
  date: string;
  readingTime?: string;
  link?: string;
  authorimage?: ImageDataLike;
  className?: string;
}

export const ArticleInformation = ({
  author,
  authorimage,
  date,
  readingTime,
  link,
  className = ''
}: ArticleInformationProps) => {
  return (
    <div className={`flex items-center justify-between ${className}`}>
      <div className="flex items-center">
        {authorimage && (
          <div className="flex-shrink-0">
            <PreviewCompatibleImage
              className="relative z-0 h-10 w-10 rounded-full"
              imageInfo={{
                image: authorimage,
                alt: `featured image thumbnail for post ${author}`,
              }}
            />
          </div>
        )}
        <div className={`${authorimage ? "ml-3" : ""}`}>
          <p className="text-sm font-semibold text-heading">
            {author}
          </p>
          <div className="flex space-x-1 text-sm text-muted">
            <time dateTime={date}>{date}</time>
            {readingTime && (
              <>
                <span aria-hidden="true">&middot;</span>
                <span>{readingTime}</span>
              </>
            )}
          </div>
        </div>
      </div>
      {link && (
        <a href={link} target="_blank" className="text-muted hover:text-heading">
          <span className="sr-only">Project Link</span>
          <GithubIcon className="h-10 w-10" />
        </a>
      )}
    </div>
  );
};