import React from "react";
import { GithubIcon } from "../icons/svg/social/Icons";
import type { ImageSource } from "../../lib/images";

interface ArticleInformationProps {
  author: string;
  date: string;
  updated?: string;
  readingTime?: string;
  link?: string;
  authorimage?: ImageSource;
  className?: string;
}

export const ArticleInformation = ({
  author,
  authorimage,
  date,
  updated,
  readingTime,
  link,
  className = "",
}: ArticleInformationProps) => {
  return (
    <div className={`flex items-center justify-between ${className}`}>
      <div className="flex items-center">
        {authorimage && (
          <div className="shrink-0">
            <img
              className="relative z-0 h-10 w-10 rounded-full object-cover"
              src={authorimage.src}
              srcSet={authorimage.srcSet}
              width={authorimage.width}
              height={authorimage.height}
              loading="lazy"
              decoding="async"
              // The name is written right beside the photo.
              alt=""
            />
          </div>
        )}
        <div className={`${authorimage ? "ml-3" : ""}`}>
          <p className="text-sm font-semibold text-heading">{author}</p>
          <div className="flex flex-wrap gap-x-1 text-sm text-muted">
            <time dateTime={date}>{date}</time>
            {updated && (
              <>
                <span aria-hidden="true">&middot;</span>
                <span>
                  Updated <time dateTime={updated}>{updated}</time>
                </span>
              </>
            )}
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
        <a href={link} target="_blank" rel="noopener noreferrer" className="text-muted hover:text-heading">
          <span className="sr-only">Project Link</span>
          <GithubIcon className="h-10 w-10" />
        </a>
      )}
    </div>
  );
};
