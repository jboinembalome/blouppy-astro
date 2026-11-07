import React from "react";
import type { PreviewTemplateComponentProps } from "decap-cms-core";
import { AboutPageTemplate } from "../../templates/about-page-template";
import { textField } from "../entry";

const AboutPagePreview = ({ entry, widgetFor, getAsset }: PreviewTemplateComponentProps) => {
  const image = textField(entry, "aboutimage");
  return (
    <AboutPageTemplate
      title={textField(entry, "title")}
      aboutimage={image ? { src: getAsset(image).toString() } : undefined}
      content={widgetFor("body") ?? ""}
    />
  );
};

export default AboutPagePreview;
