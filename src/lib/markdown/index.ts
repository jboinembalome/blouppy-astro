import { createRequire } from "node:module";
import { join } from "node:path";

// The pipeline is CommonJS (the remark 13 ecosystem Gatsby used), loaded with
// Node's own require rather than through the bundler. It is resolved from the
// project root: once bundled, this module no longer sits next to it.
const require = createRequire(join(process.cwd(), "src/lib/markdown/"));
const { render } = require("./vendor/pipeline.js") as {
  render: (
    markdown: string,
    options: { tocMaxDepth?: number; excerptLengths?: number[] }
  ) => Promise<RenderedMarkdown>;
};

export interface RenderedMarkdown {
  html: string;
  // The "On this page" list: nested <ul> of the h2 and h3 headings.
  toc: string;
  // Minutes, at 265 words a minute, as Gatsby counted them.
  timeToRead: number;
  // Plain-text excerpts, keyed by their maximum length.
  excerpts: Record<number, string>;
}

const cache = new Map<string, Promise<RenderedMarkdown>>();

// Every page that lists posts needs their reading time, so each body is
// rendered once per build and shared.
export const renderMarkdown = (markdown: string): Promise<RenderedMarkdown> => {
  let rendered = cache.get(markdown);
  if (!rendered) {
    rendered = render(markdown, { tocMaxDepth: 3, excerptLengths: [140, 200, 5000] });
    cache.set(markdown, rendered);
  }
  return rendered;
};
