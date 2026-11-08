import React, { useEffect } from "react";
import { site } from "../../lib/site";
import { getConsent, saveConsent } from "../../lib/consent";
import { useConsent } from "../consent/useConsent";

export interface DisqusConfig {
  url: string;
  identifier: string;
  title: string;
}

declare global {
  interface Window {
    disqus_config?: (this: { page: Partial<DisqusConfig> }) => void;
    DISQUS?: { reset: (options: { reload: boolean; config: Window["disqus_config"] }) => void };
  }
}

// What gatsby-plugin-disqus did: hand Disqus the page's identity, then load
// its embed script once (or reset it when it is already there).
const Disqus = ({ config }: { config: DisqusConfig }) => {
  useEffect(() => {
    window.disqus_config = function () {
      this.page.identifier = config.identifier;
      this.page.url = config.url;
      this.page.title = config.title;
    };
    if (window.DISQUS) {
      window.DISQUS.reset({ reload: true, config: window.disqus_config });
      return;
    }
    if (document.getElementById("dsq-embed-scr")) return;
    const script = document.createElement("script");
    script.src = `https://${site.disqusShortname}.disqus.com/embed.js`;
    script.id = "dsq-embed-scr";
    script.setAttribute("data-timestamp", String(Date.now()));
    script.async = true;
    document.body.appendChild(script);
  }, [config.identifier, config.url, config.title]);

  return <div id="disqus_thread" />;
};

export interface ArticleCommentsProps {
  disqusConfig: DisqusConfig;
}

// Disqus sets cookies, so it loads only once the reader has agreed to it;
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
