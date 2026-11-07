import CMS from "decap-cms-app";
import fonts from "@fontsource-variable/inter/index.css?inline";
import lineNumbers from "prismjs/plugins/line-numbers/prism-line-numbers.css?inline";
import commandLine from "prismjs/plugins/command-line/prism-command-line.css?inline";
import prismTheme from "prismjs/themes/prism-tomorrow.css?inline";
import codeButtons from "../lib/markdown/vendor/code-buttons/styles.css?inline";
import siteStyles from "../styles/site.css?inline";

import AboutPagePreview from "./preview-templates/AboutPagePreview";
import BlogPostPreview from "./preview-templates/BlogPostPreview";
import IndexPagePreview from "./preview-templates/IndexPagePreview";

// The previews render the site's own templates, so they get the site's styles.
[fonts, lineNumbers, commandLine, prismTheme, codeButtons, siteStyles].forEach((css) =>
  CMS.registerPreviewStyle(css, { raw: true }),
);

CMS.registerPreviewTemplate("index", IndexPagePreview);
CMS.registerPreviewTemplate("about", AboutPagePreview);
CMS.registerPreviewTemplate("blog", BlogPostPreview);

// The ES module build of Decap does not start itself (gatsby-plugin-decap-cms
// called init too).
CMS.init();
