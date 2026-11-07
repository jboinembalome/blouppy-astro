"use strict";

// Renders a post's Markdown the way gatsby-transformer-remark 6.16 did on the
// Gatsby site, with the same libraries at the same versions (see package.json)
// and the same three remark plugins (vendored next to this file), so moving to
// Astro changes no article's HTML, table of contents, excerpt or reading time.
// Its sources: gatsby-transformer-remark's extend-node-type.js, code-handler.js
// and utils/time-to-read.js (MIT, https://github.com/gatsbyjs/gatsby).

const remark = require("remark");
const remarkGfm = require("remark-gfm");
const remarkFootnotes = require("remark-footnotes");
const toHAST = require("mdast-util-to-hast");
const defaultCodeHandler = require("mdast-util-to-hast/lib/handlers/code");
const hastToHTML = require("hast-util-to-html");
const mdastToToc = require("mdast-util-toc");
const visit = require("unist-util-visit");
const sanitizeHTML = require("sanitize-html");
const _ = require("lodash");
const { prune } = require("underscore.string");

const path = require("path");
const sharp = require("sharp");

const autolinkHeaders = require("./autolink-headers/index.js");
const codeButtons = require("./code-buttons/index.js");
const prismjs = require("./prismjs/index.js");

// The options gatsby-config.ts gave each plugin, in the order it listed them.
const plugins = [
  [autolinkHeaders, { elements: ["h2", "h3"], isIconAfterHeader: true, className: "anchor" }],
  [
    codeButtons,
    { buttonText: "Copy", tooltipText: "Copy to clipboard", toasterText: "Copied! ✅", toasterDuration: 2000 },
  ],
  [
    prismjs,
    {
      inlineCodeMarker: "›",
      showLineNumbers: true,
      languageExtensions: [
        {
          language: "aspnet",
          definition: { superscript_types: /(SuperType)/ },
          insertBefore: { function: { superscript_keywords: /(superif|superelse)/ } },
        },
      ],
      prompt: { user: "root", host: "localhost", global: false },
      escapeEntities: {},
    },
  ],
];

const processor = remark().use(remarkGfm).use(remarkFootnotes, { inlineNotes: true });

function codeHandler(h, node) {
  const result = defaultCodeHandler(h, node);
  if (node.meta && result.children[0]) {
    result.children[0].properties.dataMeta = node.meta;
  }
  return result;
}

// Images in a post (all under public/img) get the markup gatsby-remark-images
// gave them: a box that keeps the image's ratio while it loads, over a blurred
// preview, linked to the full-size file. The files are already web-sized, so a
// single source replaces the srcset Gatsby generated.
const publicDir = path.resolve(__dirname, "../../../../public");
const MAX_WIDTH = 2048;

async function localImages(ast) {
  const images = [];
  visit(ast, "image", (node) => {
    if (node.url && node.url.startsWith("/img/")) images.push(node);
  });
  for (const node of images) {
    const file = path.join(publicDir, node.url);
    const { width, height } = await sharp(file).metadata();
    const blur = await sharp(file).resize(20).jpeg({ quality: 50 }).toBuffer();
    const displayWidth = Math.min(width, MAX_WIDTH);
    const alt = escapeAttribute(node.alt || "");
    const title = escapeAttribute(node.title || "");
    node.type = "html";
    node.value = [
      `<span class="gatsby-resp-image-wrapper" style="position: relative; display: block; margin-left: auto; margin-right: auto; max-width: ${displayWidth}px; ">`,
      `<a class="gatsby-resp-image-link" href="${node.url}" style="display: block" target="_blank" rel="noopener">`,
      `<span class="gatsby-resp-image-background-image" style="padding-bottom: ${(height / width) * 100}%; position: relative; bottom: 0; left: 0; background-image: url('data:image/jpeg;base64,${blur.toString("base64")}'); background-size: cover; display: block;"></span>`,
      `<img class="gatsby-resp-image-image" alt="${alt}" title="${title}" src="${node.url}" width="${width}" height="${height}" sizes="(max-width: ${displayWidth}px) 100vw, ${displayWidth}px" style="width:100%;height:100%;margin:0;vertical-align:middle;position:absolute;top:0;left:0;" loading="lazy" decoding="async">`,
      `</a>`,
      `</span>`,
    ].join("\n");
  }
}

function escapeAttribute(value) {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

async function parse(markdown) {
  const ast = processor.parse(markdown);
  await localImages(ast);
  for (const [plugin, options] of plugins) {
    plugin({ markdownAST: ast }, options);
  }
  return ast;
}

function toHtml(ast) {
  return hastToHTML(toHAST(ast, { allowDangerousHtml: true, handlers: { code: codeHandler } }), {
    allowDangerousHtml: true,
  });
}

function tableOfContents(ast, maxDepth) {
  const toc = mdastToToc(ast, { heading: null, maxDepth });
  return toc.map ? hastToHTML(toHAST(toc.map, { allowDangerousHtml: true }), { allowDangerousHtml: true }) : "";
}

const spaceNodeTypes = new Set(["paragraph", "heading", "tableCell", "break"]);

function excerpt(ast, pruneLength) {
  const parts = [];
  visit(ast, (node) => {
    if (node.type === "text" || node.type === "inlineCode") parts.push(node.value);
    else if (node.type === "image") parts.push(node.alt);
    else if (spaceNodeTypes.has(node.type)) parts.push(" ");
  });
  return prune(parts.join("").trim(), pruneLength, "…");
}

// Unicode ranges of Han, Hiragana and Katakana, as in time-to-read.js.
const cjRanges = [
  [11904, 11930], [11931, 12020], [12032, 12246], [12293, 12294], [12295, 12296], [12321, 12330],
  [12344, 12348], [13312, 19894], [19968, 40939], [63744, 64110], [64112, 64218], [131072, 173783],
  [173824, 177973], [177984, 178206], [178208, 183970], [183984, 191457], [194560, 195102],
  [12353, 12439], [12445, 12448], [110593, 110879], [127488, 127489], [12449, 12539], [12541, 12544],
  [12784, 12800], [13008, 13055], [13056, 13144], [65382, 65392], [65393, 65438], [110592, 110593],
];

function timeToRead(html) {
  const pureText = sanitizeHTML(html, { allowedTags: [] });
  const latin = [];
  let cj = 0;
  for (const char of pureText) {
    const code = char.codePointAt(0);
    if (cjRanges.some(([from, to]) => code >= from && code < to)) cj += 1;
    else latin.push(char);
  }
  const minutes = Math.round((_.words(latin.join("")).length + cj * 0.56) / 265);
  return minutes === 0 ? 1 : minutes;
}

// Everything a page needs from one Markdown body.
async function render(markdown, { tocMaxDepth = 3, excerptLengths = [] } = {}) {
  const ast = await parse(markdown);
  const html = toHtml(ast);
  const excerpts = Object.fromEntries(excerptLengths.map((length) => [length, excerpt(ast, length)]));
  return { html, toc: tableOfContents(ast, tocMaxDepth), timeToRead: timeToRead(html), excerpts };
}

module.exports = { render };
