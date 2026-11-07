import React from "react";
import { Tag } from "../tag";
import kebabCase from "lodash/kebabCase";

interface ArticleTagsProps {
  tags: string[];
  title?: string;
}

export const ArticleTags = ({ tags, title = "Tagged" }: ArticleTagsProps) => {
  return (
    <div className="mt-12 flex flex-wrap items-center gap-2">
      <h2 className="mr-1 text-sm font-semibold text-muted">{title}</h2>
      <ul role="list" className="flex flex-wrap gap-2">
        {tags.map((tag) => (
          <li key={tag + `tag`}>
            <Tag text={tag} link={`/tags/${kebabCase(tag)}/`} />
          </li>
        ))}
      </ul>
    </div>
  );
};
