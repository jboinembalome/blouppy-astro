import { Link } from 'gatsby';
import React from 'react';
import { GroupType } from '../../types/graphql-queries';
import kebabCase from 'lodash/kebabCase';

interface TagWithCountProps {
  tag: GroupType;
}

export const TagWithCount = ({ tag }: TagWithCountProps) => (
  <Link
    to={`/tags/${kebabCase(tag.fieldValue)}/`}
    className="inline-flex items-center gap-2 rounded-full border border-line bg-card px-3.5 py-1.5 text-sm font-medium text-body transition-colors hover:border-accent-border hover:text-accent"
  >
    {tag.fieldValue}
    <span className="text-xs text-faint">{tag.totalCount}</span>
  </Link>
);
