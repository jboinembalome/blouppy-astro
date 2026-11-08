import React from "react";
import { Link } from "../link/Link";
import { Content, HTMLContent } from "../layout/Content";
import { ArticleInformation } from "./ArticleInformation";
import { ArticleTags } from "./ArticleTags";
import { ArticleComments } from "./ArticleComments";
import { ArticleToc } from "./ArticleToc";
import { TopicIcon } from "../topic/TopicIcon";
import { topicByName } from "../../constants/topics";
import { CompactArticleCard } from "../article-card/ArticleCard";
import type { ArticleSummaryEdge } from "../../lib/posts";
import type { ImageSource } from "../../lib/images";

export interface ArticleProps {
  title: string;
  content: string | JSX.Element | JSX.Element[];
  date?: string;
  updated?: string;
  description?: string;
  category?: string;
  topic?: string;
  tags?: string[];
  author?: string;
  authorimage?: ImageSource;
  readingTime?: string;
  imageLink?: string;
  imageCreator?: string;
  imageSource?: string;
  link?: string;
  // Set on a blog post: the breadcrumb and the comments show.
  isPost?: boolean;
  // Blog posts only: the "On this page" list and the posts to read next.
  tableOfContents?: string;
  related?: ArticleSummaryEdge[];
  // Filled by the Astro page with the interactive parts, hydrated on their
  // own: the rest of the article stays static HTML.
  toc?: React.ReactNode;
  comments?: React.ReactNode;
}

// The reading page, laid out like the Starter's docs: one column of text at a
// comfortable measure, and the table of contents beside it from lg up. No
// cover on screen: the title is already there. The cover, when a post has one,
// only serves as the image of a shared link (see the page's Head).
export const Article = (props: ArticleProps) => {
  const isNotHTMLContent = typeof props.content !== "string";
  const hasToc = !!props.tableOfContents && props.tableOfContents.includes("<li");
  const bodyClassName = "article-body prose prose-blouppy max-w-none lg:prose-lg";
  const topic = topicByName(props.topic);

  return (
    <div className={hasToc ? "lg:grid lg:grid-cols-[minmax(0,1fr)_14rem] lg:gap-14" : ""}>
      <article className="mx-auto w-full min-w-0 max-w-3xl">
        <header className="flex flex-col gap-5">
          {props.isPost && (
            <nav aria-label="Breadcrumb" className="flex flex-wrap items-center gap-2 text-sm font-medium text-muted">
              <Link to="/blog/" className="hover:text-accent">
                Articles
              </Link>
              {topic && (
                <>
                  <span aria-hidden="true">›</span>
                  <Link
                    to={`/blog/?topic=${topic.slug}`}
                    className="inline-flex items-center gap-2 text-accent hover:underline"
                  >
                    <TopicIcon topic={topic} size="sm" />
                    {topic.name}
                  </Link>
                </>
              )}
            </nav>
          )}
          <h1 className="text-3xl font-extrabold leading-tight tracking-tight text-heading sm:text-4xl sm:leading-10 lg:text-[2.75rem]">
            {props.title}
          </h1>
          {props.description && (
            <p className="text-lg leading-relaxed text-muted sm:text-xl sm:leading-7">{props.description}</p>
          )}
          {props.author && props.date && (
            <ArticleInformation
              author={props.author}
              authorimage={props.authorimage}
              date={props.date}
              updated={props.updated}
              readingTime={props.readingTime ?? ""}
              link={props.link}
            />
          )}
        </header>

        <div className="mt-10">
          {isNotHTMLContent && React.isValidElement(props.content) ? (
            <Content className={bodyClassName} content={props.content} />
          ) : (
            <HTMLContent className={bodyClassName} content={props.content as string} />
          )}
        </div>

        {props.tags && props.tags.length > 0 && <ArticleTags tags={props.tags} />}

        {props.related && props.related.length > 0 && (
          <section aria-labelledby="related-title" className="mt-14 border-t border-line pt-10">
            <h2 id="related-title" className="mb-6 text-xl font-semibold text-heading">
              Keep reading
            </h2>
            <div className="grid gap-4 sm:grid-cols-3">
              {props.related.map(({ node }) => (
                <CompactArticleCard key={node.id} article={node} />
              ))}
            </div>
          </section>
        )}

        {props.isPost && (props.comments ?? <ArticleComments />)}
      </article>

      {hasToc && (
        <aside className="hidden lg:block">
          <div className="sticky top-[calc(var(--nav-height)+2rem)] max-h-[calc(100vh-var(--nav-height)-4rem)] overflow-y-auto pb-6">
            {props.toc ?? <ArticleToc html={props.tableOfContents as string} />}
          </div>
        </aside>
      )}
    </div>
  );
};
