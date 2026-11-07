import { Link } from "../link/Link";
import React from "react";

export interface TagProps {
  text?: string;
  // Kept for the posts' `categorycolor` front matter; the design now gives
  // every tag the same tinted chip, so it is ignored.
  color?: string;
  link?: string;
  isRoundedFull?: boolean;
  className?: string;
}

export const Tag = ({ text, link, className = "" }: TagProps) => {
  const concatClassName = `chip ${link ? "transition-colors hover:border-accent" : ""} ${className}`;

  if (link)
    return (
      <Link to={link} className={concatClassName}>
        {text}
      </Link>
    );

  return <span className={concatClassName}>{text}</span>;
};
