import React, { useEffect, useMemo, useRef, useState } from "react";
import { ArticleCard } from "../article-card/ArticleCard";
import { ArticleSummaryEdge } from "../../types/graphql-queries/ArticleSummaryQuery";
import { topicBySlug, topics } from "../../constants/topics";

// Three columns on a wide screen: nine is three full rows.
const PAGE_SIZE = 9;

interface ArticleIndexProps {
  articles: ArticleSummaryEdge[];
}

const readTopicFromUrl = () => {
  const slug = new URLSearchParams(window.location.search).get("topic");
  return topicBySlug(slug)?.slug ?? null;
};

// The Articles page: every post in a grid, filtered by topic and revealed nine
// at a time as the reader scrolls. The topic lives in the URL
// (/blog/?topic=security) so a filtered list can be shared.
export const ArticleIndex = ({ articles }: ArticleIndexProps) => {
  // The HTML is built without a query string, so the topic is read once the
  // page has hydrated: reading it during the first render would not match.
  const [topicSlug, setTopicSlug] = useState<string | null>(null);
  const [urlRead, setUrlRead] = useState(false);
  const [visible, setVisible] = useState(PAGE_SIZE);
  const sentinel = useRef<HTMLDivElement>(null);

  const counts = useMemo(() => {
    const byTopic = new Map<string, number>();
    articles.forEach(({ node }) => {
      const name = node.frontmatter.topic;
      if (name) byTopic.set(name, (byTopic.get(name) ?? 0) + 1);
    });
    return byTopic;
  }, [articles]);

  const active = topicBySlug(topicSlug);
  const pool = useMemo(
    () => (active ? articles.filter(({ node }) => node.frontmatter.topic === active.name) : articles),
    [articles, active]
  );
  const shown = pool.slice(0, visible);
  const hasMore = visible < pool.length;

  const selectTopic = (slug: string | null) => {
    setTopicSlug((current) => (current === slug ? null : slug));
    setVisible(PAGE_SIZE);
  };

  useEffect(() => {
    setTopicSlug(readTopicFromUrl());
    setUrlRead(true);
  }, []);

  useEffect(() => {
    if (!urlRead) return;
    const url = new URL(window.location.href);
    if (topicSlug) url.searchParams.set("topic", topicSlug);
    else url.searchParams.delete("topic");
    window.history.replaceState(window.history.state, "", url.pathname + url.search + url.hash);
  }, [topicSlug, urlRead]);

  // Load the next nine a little before the end of the grid comes into view.
  useEffect(() => {
    const element = sentinel.current;
    if (!element || !hasMore || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) setVisible((count) => count + PAGE_SIZE);
      },
      { rootMargin: "600px 0px" }
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [hasMore, shown.length]);

  const chipClassName = (isActive: boolean) =>
    `inline-flex shrink-0 items-center gap-1.5 rounded-full border px-3.5 py-1.5 text-sm font-medium transition-colors ${
      isActive ? "border-accent-border bg-accent-soft text-accent" : "border-line bg-card text-body hover:border-accent-border hover:text-accent"
    }`;

  return (
    <>
      <section aria-labelledby="articles-title" id="articles" className="scroll-mt-24">
        <div className={`mb-6 flex flex-col gap-4 lg:flex-row lg:items-center ${active ? "lg:justify-between" : ""}`}>
          {/* The page title already says "Articles": the heading shows only for a topic. */}
          <h2 id="articles-title" className={active ? "text-3xl font-extrabold tracking-tight text-heading" : "sr-only"}>
            {active ? active.name : "All articles"}
          </h2>
          {/* On a phone the topics scroll sideways rather than wrap. */}
          <ul
            className={`-mx-4 flex gap-2 overflow-x-auto px-4 pb-1 [scrollbar-width:none] md:mx-0 md:flex-wrap md:overflow-visible md:px-0 ${active ? "lg:justify-end" : ""}`}
            aria-label="Filter by topic"
          >
            <li className="shrink-0">
              <button type="button" className={chipClassName(!active)} aria-pressed={!active} onClick={() => selectTopic(null)}>
                All
              </button>
            </li>
            {topics
              .filter((topic) => counts.has(topic.name))
              .map((topic) => (
                <li key={topic.slug} className="shrink-0">
                  <button
                    type="button"
                    className={chipClassName(active?.slug === topic.slug)}
                    aria-pressed={active?.slug === topic.slug}
                    onClick={() => selectTopic(topic.slug)}
                  >
                    {topic.name}
                  </button>
                </li>
              ))}
          </ul>
        </div>

        <p className="-mt-2 mb-6 text-base text-muted" aria-live="polite">
          {active ? `${active.description} ` : ""}
          {pool.length} article{pool.length === 1 ? "" : "s"}.
        </p>

        <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
          {shown.map(({ node }) => (
            <ArticleCard key={node.id} article={node} />
          ))}
        </div>

        {hasMore && (
          <div ref={sentinel} className="mt-10 flex justify-center">
            <button type="button" className="btn-outline btn-sm" onClick={() => setVisible((count) => count + PAGE_SIZE)}>
              Show more
            </button>
          </div>
        )}
      </section>
    </>
  );
};
