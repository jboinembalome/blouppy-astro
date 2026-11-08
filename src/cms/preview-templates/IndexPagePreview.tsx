import React from "react";
import type { PreviewTemplateComponentProps } from "decap-cms-core";
import { IndexPageTemplate } from "../../templates/index-page-template";
import { textField } from "../entry";

const IndexPagePreview = ({ entry }: PreviewTemplateComponentProps) => (
  <IndexPageTemplate title={textField(entry, "title")} subheading={textField(entry, "subheading")} articles={[]} />
);

export default IndexPagePreview;
