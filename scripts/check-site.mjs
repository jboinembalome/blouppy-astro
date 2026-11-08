// Checks the built site (dist/) the way a crawler and a reader would meet it:
// every page has its title, description, canonical URL, Open Graph tags and
// Content Security Policy; every link and asset it points to exists; the
// sitemap, the feed, robots.txt and the manifest are complete.
//
// Usage: node scripts/check-site.mjs [dist]
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { parse } from "node-html-parser";

const root = process.argv[2] ?? "dist";
const problems = [];
const fail = (where, message) => problems.push(`${where}: ${message}`);

const walk = (dir) =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });

const files = walk(root);
const pages = files.filter((file) => file.endsWith(".html"));
const urlOf = (file) => {
  const path = "/" + relative(root, file).split(sep).join("/");
  return path.endsWith("/index.html") ? path.slice(0, -"index.html".length) : path;
};

// A path under the site resolves to a file, or to a directory's index.html.
const resolves = (path) => {
  const clean = decodeURI(path.split(/[?#]/)[0]);
  const target = join(root, clean);
  if (existsSync(target) && statSync(target).isFile()) return true;
  return existsSync(join(target, "index.html"));
};

const isAdmin = (url) => url.startsWith("/admin/");
const notIndexed = new Set(["/contact/thanks/", "/404/", "/404.html"]);

for (const file of pages) {
  const url = urlOf(file);
  const document = parse(readFileSync(file, "utf8"));
  const meta = (selector) => document.querySelector(selector)?.getAttribute("content");

  if (!isAdmin(url)) {
    if (document.querySelector("html")?.getAttribute("lang") !== "en") fail(url, 'no <html lang="en">');
    if (!document.querySelector("title")?.text.trim()) fail(url, "no <title>");
    if (!meta('meta[name="description"]')) fail(url, "no meta description");
    if (!document.querySelector('link[rel="canonical"]')?.getAttribute("href")) fail(url, "no canonical URL");
    for (const property of ["og:title", "og:description", "og:image", "og:url"]) {
      if (!meta(`meta[property="${property}"]`)) fail(url, `no ${property}`);
    }
    const csp = meta('meta[http-equiv="content-security-policy"]') ?? "";
    if (!/script-src [^;]*'self'/.test(csp) || !csp.includes("object-src 'none'")) {
      fail(url, "no Content Security Policy");
    }
    if (document.querySelectorAll("h1").length !== 1) fail(url, `${document.querySelectorAll("h1").length} <h1>`);
    for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
      try {
        JSON.parse(script.text);
      } catch {
        fail(url, "invalid JSON-LD");
      }
    }
    // An inline event handler would be refused by the Content Security Policy.
    if (/\son[a-z]+="/i.test(document.querySelector("body")?.innerHTML ?? "")) fail(url, "inline event handler");
  }

  const references = [
    ...document.querySelectorAll("a[href]").map((element) => element.getAttribute("href")),
    ...document.querySelectorAll("[src]").map((element) => element.getAttribute("src")),
    ...document.querySelectorAll("link[href]").map((element) => element.getAttribute("href")),
    ...document.querySelectorAll("[srcset]").flatMap((element) =>
      element
        .getAttribute("srcset")
        .split(",")
        .map((entry) => entry.trim().split(/\s+/)[0]),
    ),
  ];
  for (const reference of new Set(references)) {
    if (!reference || !reference.startsWith("/") || reference.startsWith("//")) continue;
    if (!resolves(reference)) fail(url, `broken link or asset ${reference}`);
  }
}

// The sitemap lists every indexable page, and only pages that exist.
const sitemap = readFileSync(join(root, "sitemap-0.xml"), "utf8");
const listed = new Set([...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map(([, loc]) => new URL(loc).pathname));
for (const path of listed) if (!resolves(path)) fail("sitemap", `lists a missing page ${path}`);
for (const url of pages.map(urlOf)) {
  if (!isAdmin(url) && !notIndexed.has(url) && !listed.has(url)) fail("sitemap", `misses ${url}`);
}

// The feed carries every article, in full.
const posts = readdirSync("src/content/blog").filter((name) => name.endsWith(".md")).length;
const feed = readFileSync(join(root, "rss.xml"), "utf8");
const items = [...feed.matchAll(/<item>([\s\S]*?)<\/item>/g)].map(([, item]) => item);
if (items.length !== posts) fail("rss.xml", `${items.length} items for ${posts} articles`);
items.forEach((item, index) => {
  for (const tag of ["title", "link", "guid", "pubDate", "description", "content:encoded"]) {
    if (!item.includes(`<${tag}`)) fail("rss.xml", `item ${index + 1} has no <${tag}>`);
  }
});

if (!existsSync(join(root, "robots.txt"))) fail("robots.txt", "missing");
const manifest = JSON.parse(readFileSync(join(root, "manifest.webmanifest"), "utf8"));
for (const icon of manifest.icons) if (!resolves(icon.src)) fail("manifest", `missing icon ${icon.src}`);

if (problems.length) {
  console.error(problems.join("\n"));
  console.error(`\n${problems.length} problem(s) in ${pages.length} pages.`);
  process.exit(1);
}
console.log(
  `Site checked: ${pages.length} pages, ${listed.size} in the sitemap, ${items.length} articles in the feed.`,
);
