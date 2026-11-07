import React, { useEffect } from "react";
import { site } from "../../lib/site";

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

export const ArticleComments = ({ disqusConfig }: ArticleCommentsProps) => (
  <section aria-labelledby="comments-title" className="mt-12 rounded-xl border border-line bg-card px-4 py-4 sm:px-6">
    <h2 id="comments-title" className="mb-2 text-lg font-semibold text-heading">
      Comments
    </h2>
    <Disqus config={disqusConfig} />
  </section>
);
