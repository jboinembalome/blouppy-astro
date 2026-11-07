import React, { useMemo } from "react";
import { Link } from "gatsby";
import { ArticleCard, FeaturedArticleCard } from "../article-card/ArticleCard";
import { ArticleSummaryEdge } from "../../types/graphql-queries/ArticleSummaryQuery";
import { topics } from "../../constants/topics";
import { TopicIcon } from "../topic/TopicIcon";

// Two full rows of three under the featured card.
const RECENT_COUNT = 6;

interface HomeArticlesProps {
  articles: ArticleSummaryEdge[];
}

// The home page shows a fixed selection: the newest post, the six before it
// and the topics. Every post, filtered and scrolled, lives on /blog/.
export const HomeArticles = ({ articles }: HomeArticlesProps) => {
  const [featured, ...rest] = articles;
  const recent = rest.slice(0, RECENT_COUNT);

  const counts = useMemo(() => {
    const byTopic = new Map<string, number>();
    articles.forEach(({ node }) => {
      const name = node.frontmatter.topic;
      if (name) byTopic.set(name, (byTopic.get(name) ?? 0) + 1);
    });
    return byTopic;
  }, [articles]);

  return (
    <>
      {featured && (
        <section aria-labelledby="latest-title" className="mb-14">
          <h2 id="latest-title" className="section-kicker">
            Latest article
          </h2>
          <FeaturedArticleCard article={featured.node} />
        </section>
      )}

      <section aria-labelledby="recent-title" id="articles" className="mb-16 scroll-mt-24">
        <div className="mb-6 flex items-end justify-between gap-4">
          <h2 id="recent-title" className="text-3xl font-extrabold tracking-tight text-heading">
            Recent articles
          </h2>
          <Link to="/blog/" className="shrink-0 text-sm font-semibold text-accent hover:underline">
            All articles <span aria-hidden="true">→</span>
          </Link>
        </div>
        <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
          {recent.map(({ node }) => (
            <ArticleCard key={node.id} article={node} />
          ))}
        </div>
      </section>

      <section aria-labelledby="topics-title">
        <h2 id="topics-title" className="mb-6 text-3xl font-extrabold tracking-tight text-heading">
          Browse by topic
        </h2>
        <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {topics
            .filter((topic) => counts.has(topic.name))
            .map((topic) => (
              <li key={topic.slug}>
                <Link
                  to={`/blog/?topic=${topic.slug}`}
                  className="group flex h-full flex-col gap-3 rounded-xl border border-line bg-card p-5 transition-colors hover:border-accent-border"
                >
                  <span className="flex items-center gap-3">
                    <TopicIcon topic={topic} size="sm" />
                    <span className="font-semibold text-heading group-hover:text-accent">{topic.name}</span>
                  </span>
                  <span className="text-sm leading-relaxed text-muted">{topic.description}</span>
                  <span className="mt-auto text-sm font-medium text-faint">
                    {counts.get(topic.name)} article{counts.get(topic.name) === 1 ? "" : "s"}
                  </span>
                </Link>
              </li>
            ))}
        </ul>
        <div className="mt-10 flex justify-center">
          <Link to="/blog/" className="btn-outline">
            Browse all {articles.length} articles
          </Link>
        </div>
      </section>
    </>
  );
};
