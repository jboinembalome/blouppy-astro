import { useEffect, useRef } from "react";
import { giscus } from "../../lib/site";

// Giscus' theme for the site's scheme: its light theme on the light page, a
// transparent dark one on the dark page, so the card behind shows through.
const themeOf = () => (document.documentElement.classList.contains("dark") ? "transparent_dark" : "light");

// The comments of an article, from a GitHub Discussion of the blog's
// repository (giscus.app). Giscus sets no tracking cookie, so it needs no
// consent: the reader only signs in with GitHub to write.
const Giscus = () => {
  const container = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const element = container.current;
    if (!element || element.querySelector("script, iframe")) return;

    const script = document.createElement("script");
    script.src = "https://giscus.app/client.js";
    script.async = true;
    script.crossOrigin = "anonymous";
    Object.entries({
      repo: giscus.repo,
      repoId: giscus.repoId,
      category: giscus.category,
      categoryId: giscus.categoryId,
      mapping: "pathname",
      strict: "0",
      reactionsEnabled: "1",
      emitMetadata: "0",
      inputPosition: "bottom",
      theme: themeOf(),
      lang: "en",
      loading: "lazy",
    }).forEach(([key, value]) => (script.dataset[key] = value));
    element.appendChild(script);

    // The theme menu switches the page's scheme without a reload: tell the
    // comments' frame to follow.
    const observer = new MutationObserver(() => {
      const frame = element.querySelector<HTMLIFrameElement>("iframe.giscus-frame");
      frame?.contentWindow?.postMessage({ giscus: { setConfig: { theme: themeOf() } } }, "https://giscus.app");
    });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    return () => observer.disconnect();
  }, []);

  return <div ref={container} className="giscus" />;
};

export const ArticleComments = () => (
  <section aria-labelledby="comments-title" className="mt-12 rounded-xl border border-line bg-card px-4 py-4 sm:px-6">
    <h2 id="comments-title" className="mb-2 text-lg font-semibold text-heading">
      Comments
    </h2>
    <Giscus />
  </section>
);
