import React, { useEffect, useRef } from "react";

interface ArticleTocProps {
  // The HTML list gatsby-transformer-remark builds from the post's headings.
  html: string;
}

// "On this page", as in the Starter's docs: sticky beside the article, the
// section being read highlighted as the reader scrolls.
export const ArticleToc = ({ html }: ArticleTocProps) => {
  const ref = useRef<HTMLElement>(null);

  useEffect(() => {
    const container = ref.current;
    if (!container || typeof IntersectionObserver === "undefined") return;

    const links = Array.from(container.querySelectorAll<HTMLAnchorElement>("a[href*='#']"));
    const byId = new Map<string, HTMLAnchorElement>();
    links.forEach((link) => {
      const id = decodeURIComponent(link.hash.slice(1));
      if (id) byId.set(id, link);
    });

    const headings = Array.from(byId.keys())
      .map((id) => document.getElementById(id))
      .filter((heading): heading is HTMLElement => heading !== null);
    if (headings.length === 0) return;

    const setActive = (id: string) =>
      links.forEach((link) => link.classList.toggle("is-active", link === byId.get(id)));

    // A heading counts as current once it passes the top fifth of the viewport.
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((entry) => entry.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (visible.length > 0) setActive(visible[0].target.id);
      },
      { rootMargin: "0px 0px -80% 0px" },
    );

    headings.forEach((heading) => observer.observe(heading));
    return () => observer.disconnect();
  }, [html]);

  return (
    <nav ref={ref} aria-labelledby="toc-title" className="toc">
      <p id="toc-title" className="mb-3 text-xs font-semibold uppercase tracking-wider text-faint">
        On this page
      </p>
      <div dangerouslySetInnerHTML={{ __html: html }} />
    </nav>
  );
};
