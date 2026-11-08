import React from "react";
import { Article, type ArticleProps, type DisqusConfig } from "../components/article";

interface BlogPostTemplateProps extends ArticleProps {
  slug: string;
}

// Disqus keys a thread by the production URL, whichever deploy shows it.
export const disqusConfigOf = (slug: string, title: string): DisqusConfig => ({
  url: "https://blouppy.com" + slug,
  identifier: slug,
  title,
});

export const BlogPostTemplate = (props: BlogPostTemplateProps) => {
  const disqusConfig = disqusConfigOf(props.slug, props.title);

  return (
    <Article
      title={props.title}
      date={props.date}
      updated={props.updated}
      description={props.description}
      category={props.category}
      topic={props.topic}
      tags={props.tags}
      imageLink={props.imageLink}
      imageCreator={props.imageCreator}
      imageSource="https://unsplash.com/"
      author={props.author}
      authorimage={props.authorimage}
      readingTime={props.readingTime}
      content={props.content}
      tableOfContents={props.tableOfContents}
      related={props.related}
      toc={props.toc}
      comments={props.comments}
      disqusConfig={disqusConfig}
    />
  );
};
