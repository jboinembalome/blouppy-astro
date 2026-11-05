import { IGatsbyImageData } from "gatsby-plugin-image";
import React from "react";
import { Link } from "gatsby";
import { Content, HTMLContent } from "../layout/Content";
import { ArticleInformation } from "./ArticleInformation";
import { ArticleImage } from "./ArticleImage";
import { ArticleTags } from "./ArticleTags";
import { DisqusConfig } from "gatsby-plugin-disqus";
import { ArticleComments } from "./ArticleComments";
import { ArticleImageCaption } from "./ArticleImageCaption";
import { ArticleToc } from "./ArticleToc";
import { ArticleCard } from "../article-card/ArticleCard";
import { ArticleSummaryEdge } from "../../types/graphql-queries/ArticleSummaryQuery";

export interface ArticleProps {
    title: string;
    content: string | JSX.Element | JSX.Element[];
    date?: string;
    description?: string;
    category?: string;
    tags?: string[];
    author?: string;
    authorimage?: {
        childImageSharp: {
            gatsbyImageData: IGatsbyImageData;
        };
    };
    readingTime?: string;
    image?: {
        childImageSharp: {
            gatsbyImageData: IGatsbyImageData;
        };
    };
    imageLink?: string;
    imageCreator?: string;
    imageSource?: string;
    link?: string;
    disqusConfig?: DisqusConfig;
    // Blog posts only: the "On this page" list and the posts to read next.
    tableOfContents?: string;
    related?: ArticleSummaryEdge[];
}

// The reading page, laid out like the Starter's docs: one column of text at a
// comfortable measure, and the table of contents beside it from lg up. No
// decoration here — the flamingo shapes stay on the home page (DESIGN.md §2.5).
export const Article = (props: ArticleProps) => {
    const isNotHTMLContent = typeof props.content !== 'string';
    const hasToc = !!props.tableOfContents && props.tableOfContents.includes("<li");
    const bodyClassName = "article-body prose prose-blouppy max-w-none lg:prose-lg";

    return (
        <div className={hasToc ? "lg:grid lg:grid-cols-[minmax(0,1fr)_14rem] lg:gap-14" : ""}>
            <article className="mx-auto w-full min-w-0 max-w-3xl">
                <header className="flex flex-col gap-5">
                    {props.disqusConfig && (
                        <div className="flex flex-wrap items-center gap-3 text-sm">
                            <Link to="/blog" className="font-medium text-muted hover:text-accent">← All articles</Link>
                            {props.category && <span className="chip text-xs">{props.category}</span>}
                        </div>
                    )}
                    <h1 className="text-3xl font-extrabold leading-tight tracking-tight text-heading sm:text-4xl lg:text-[2.75rem]">
                        {props.title}
                    </h1>
                    {props.description && (
                        <p className="text-lg leading-relaxed text-muted sm:text-xl">
                            {props.description}
                        </p>
                    )}
                    {props.author && props.date && (
                        <ArticleInformation author={props.author} authorimage={props.authorimage} date={props.date} readingTime={props.readingTime ?? ''} link={props.link} />
                    )}
                    {props.image && (
                        <figure className="mt-2 flex flex-col gap-3">
                            <ArticleImage image={props.image} alt="" />
                            {props.imageLink && props.imageCreator && (
                                <ArticleImageCaption imageLink={props.imageLink} imageCreator={props.imageCreator} source={props.imageSource} />
                            )}
                        </figure>
                    )}
                </header>

                <div className="mt-10">
                    {isNotHTMLContent && React.isValidElement(props.content)
                        ? <Content className={bodyClassName} content={props.content} />
                        : <HTMLContent className={bodyClassName} content={props.content as string} />
                    }
                </div>

                {props.tags && props.tags.length > 0 && (
                    <ArticleTags tags={props.tags} />
                )}

                {props.related && props.related.length > 0 && (
                    <section aria-labelledby="related-title" className="mt-14 border-t border-line pt-10">
                        <h2 id="related-title" className="mb-6 text-xl font-semibold text-heading">Keep reading</h2>
                        <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
                            {props.related.map(({ node }) => (
                                <ArticleCard key={node.id} article={node} showExcerpt={false} />
                            ))}
                        </div>
                    </section>
                )}

                {props.disqusConfig && (
                    <ArticleComments disqusConfig={props.disqusConfig} />
                )}
            </article>

            {hasToc && (
                <aside className="hidden lg:block">
                    <div className="sticky top-[calc(var(--nav-height)_+_2rem)] max-h-[calc(100vh_-_var(--nav-height)_-_4rem)] overflow-y-auto pb-6">
                        <ArticleToc html={props.tableOfContents as string} />
                    </div>
                </aside>
            )}
        </div>
    );
};
