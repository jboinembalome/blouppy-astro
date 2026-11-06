import React from "react";
import { Disqus, DisqusConfig } from "gatsby-plugin-disqus";
import { getConsent, saveConsent, useConsent } from "../consent/consent";

export interface ArticleCommentsProps {
  disqusConfig: DisqusConfig;
}

// Disqus sets cookies, so it is loaded only once the reader has agreed to it;
// until then the section offers to load it.
export const ArticleComments = ({ disqusConfig }: ArticleCommentsProps) => {
  const consent = useConsent();

  return (
    <section aria-labelledby="comments-title" className="mt-12 rounded-xl border border-line bg-card px-4 py-4 sm:px-6">
      <h2 id="comments-title" className="mb-2 text-lg font-semibold text-heading">
        Comments
      </h2>
      {consent?.comments ? (
        <Disqus config={disqusConfig} />
      ) : (
        <div className="flex flex-col gap-3 py-2 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-sm text-muted">Comments are provided by Disqus, which sets cookies once loaded.</p>
          <button
            type="button"
            className="btn-outline btn-sm shrink-0"
            onClick={() => saveConsent({ analytics: Boolean(getConsent()?.analytics), comments: true })}
          >
            Load comments
          </button>
        </div>
      )}
    </section>
  );
};
