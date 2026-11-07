import { Link } from "../link/Link";
import React from "react";
import kebabCase from "lodash/kebabCase";

export interface TagCount {
  tag: string;
  count: number;
}

interface TagWithCountProps {
  tag: TagCount;
}

export const TagWithCount = ({ tag }: TagWithCountProps) => (
  <Link
    to={`/tags/${kebabCase(tag.tag)}/`}
    className="inline-flex items-center gap-2 rounded-full border border-line bg-card px-3.5 py-1.5 text-sm font-medium text-body transition-colors hover:border-accent-border hover:text-accent"
  >
    {tag.tag}
    <span className="text-xs text-faint">{tag.count}</span>
  </Link>
);
