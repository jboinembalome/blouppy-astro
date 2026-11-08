import React from "react";
import { Article, type ArticleProps } from "../components/article";

interface BlogPostTemplateProps extends ArticleProps {
  slug: string;
}

export const BlogPostTemplate = (props: BlogPostTemplateProps) => {
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
      isPost
    />
  );
};
