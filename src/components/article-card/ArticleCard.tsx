import React from "react";
import { Link } from "../link/Link";
import type { ArticleSummary } from "../../lib/posts";
import { TopicIllustration } from "../topic/TopicIllustration";

const Meta = ({ article }: { article: ArticleSummary }) => (
  <p className="mt-auto flex flex-wrap gap-x-1.5 pt-1 text-xs text-faint">
    <time className="whitespace-nowrap">{article.frontmatter.date}</time>
    <span aria-hidden="true">·</span>
    <span className="whitespace-nowrap">{article.timeToRead} min read</span>
  </p>
);

// The written description reads better than an excerpt, which loses inline code.
const summaryOf = (article: ArticleSummary) => article.frontmatter.description || article.excerpt;

const cardClassName =
  "group flex overflow-hidden rounded-xl border border-line bg-card transition duration-200 hover:-translate-y-0.5 hover:border-accent-border hover:shadow-sm";

interface ArticleCardProps {
  article: ArticleSummary;
  headingLevel?: "h2" | "h3";
}

// A card of the grid: the topic's illustration above, then the topic, the
// title, two lines of description and the date.
export const ArticleCard = ({ article, headingLevel = "h3" }: ArticleCardProps) => {
  const Heading = headingLevel;
  const { topic, illustration, title } = article.frontmatter;

  return (
    <Link to={article.fields.slug} className={`${cardClassName} flex-col`}>
      <TopicIllustration topic={topic} variant={illustration} className="h-44 border-b border-line p-6" />
      <div className="flex flex-1 flex-col gap-2 p-5">
        {topic && <span className="text-xs font-semibold text-accent">{topic}</span>}
        <Heading className="text-lg font-semibold leading-snug text-heading group-hover:text-accent">{title}</Heading>
        <p className="line-clamp-2 text-sm leading-relaxed text-muted">{summaryOf(article)}</p>
        <Meta article={article} />
      </div>
    </Link>
  );
};

// The newest post, larger, with the illustration beside the text from md up.
export const FeaturedArticleCard = ({ article }: { article: ArticleSummary }) => {
  const { topic, illustration, title } = article.frontmatter;

  return (
    <Link to={article.fields.slug} className={`${cardClassName} flex-col md:grid md:grid-cols-[1.05fr_1fr]`}>
      <TopicIllustration topic={topic} variant={illustration} className="h-52 border-b border-line p-8 md:h-full md:min-h-[18rem] md:border-b-0 md:border-r" />
      <div className="flex flex-col justify-center gap-3 p-6 md:p-9">
        {topic && <span className="text-sm font-semibold text-accent">{topic}</span>}
        <h3 className="text-2xl font-bold leading-tight tracking-tight text-heading group-hover:text-accent md:text-[1.7rem]">{title}</h3>
        <p className="line-clamp-3 text-base leading-relaxed text-muted">{summaryOf(article)}</p>
        <Meta article={article} />
      </div>
    </Link>
  );
};

// A smaller card for the "Keep reading" block under an article.
export const CompactArticleCard = ({ article }: { article: ArticleSummary }) => {
  const { topic, illustration, title } = article.frontmatter;

  return (
    <Link to={article.fields.slug} className={`${cardClassName} h-full flex-col`}>
      <TopicIllustration topic={topic} variant={illustration} className="h-28 border-b border-line p-4" />
      <div className="flex flex-1 flex-col gap-1.5 p-4">
        {topic && <span className="text-xs font-semibold text-accent">{topic}</span>}
        <h3 className="font-semibold leading-snug text-heading group-hover:text-accent">{title}</h3>
        <Meta article={article} />
      </div>
    </Link>
  );
};
