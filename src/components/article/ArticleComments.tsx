import React from 'react';
import { Disqus, DisqusConfig } from 'gatsby-plugin-disqus';

export interface ArticleCommentsProps {
  disqusConfig: DisqusConfig;
}

export const ArticleComments = ({ disqusConfig }: ArticleCommentsProps) => {

  return (
    <section aria-labelledby="comments-title" className="mt-12 rounded-xl border border-line bg-card px-4 py-4 sm:px-6">
      <h2 id="comments-title" className="mb-2 text-lg font-semibold text-heading">Comments</h2>
      <Disqus config={disqusConfig} />
    </section>
  )
};
