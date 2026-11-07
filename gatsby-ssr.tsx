import React from "react";
import type { GatsbySSR } from "gatsby";
import { withPrefix } from "gatsby";
import { Layout } from "./src/components/layout";
import { pageKindOf } from "./src/components/layout/Layout";

// The same wrapper as gatsby-browser, so the HTML built for a page is the page
// the browser hydrates.
export const wrapPageElement: GatsbySSR["wrapPageElement"] = ({ element, props }) => (
  <Layout kind={pageKindOf(props.location.pathname)}>{element}</Layout>
);

// Runs in <head>, before the body is painted: a reader who chose the dark
// theme never sees the light one flash first.
const themeScript = `
try {
  if (localStorage.theme === 'dark' || (!('theme' in localStorage) && window.matchMedia('(prefers-color-scheme: dark)').matches)) {
    document.documentElement.classList.add('dark')
  } else {
    document.documentElement.classList.remove('dark')
  }
} catch (_) {}
`;

export const onRenderBody: GatsbySSR["onRenderBody"] = ({ setHtmlAttributes, setHeadComponents }) => {
  setHtmlAttributes({ lang: "en" });
  setHeadComponents([
    <script key="theme-initialize" dangerouslySetInnerHTML={{ __html: themeScript }} />,
    <link key="apple-touch-icon" rel="apple-touch-icon" sizes="180x180" href={withPrefix("/img/apple-touch-icon.png")} />,
    <link key="favicon" rel="icon" href={withPrefix("/img/favicon.ico")} sizes="any" />,
    <link key="favicon-32" rel="icon" type="image/png" sizes="32x32" href={withPrefix("/img/favicon-32x32.png")} />,
    <link key="favicon-16" rel="icon" type="image/png" sizes="16x16" href={withPrefix("/img/favicon-16x16.png")} />,
    <link key="mask-icon" rel="mask-icon" href={withPrefix("/img/safari-pinned-tab.svg")} color="#676dcf" />,
  ]);
};
