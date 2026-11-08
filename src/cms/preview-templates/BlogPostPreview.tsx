import React from "react";
import type { PreviewTemplateComponentProps } from "decap-cms-core";
import { BlogPostTemplate } from "../../templates/blog-post-template";
import { listField, textField } from "../entry";

const BlogPostPreview = ({ entry, widgetFor }: PreviewTemplateComponentProps) => (
  <BlogPostTemplate
    content={widgetFor("body") ?? ""}
    description={textField(entry, "description")}
    tags={listField(entry, "tags")}
    title={textField(entry, "title")}
    slug={String(entry.get("slug") ?? "")}
    // No comment thread in the editor.
    comments={false}
  />
);

export default BlogPostPreview;
