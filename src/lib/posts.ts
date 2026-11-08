import matter from "gray-matter";
import kebabCase from "lodash/kebabCase";
import { renderMarkdown } from "./markdown";

// The Markdown files, read through the bundler so the dev server reloads when
// one changes (src/content/blog/<yyyy-mm-dd-slug>.md, edited by Decap CMS).
const postFiles = import.meta.glob<string>("/src/content/blog/*.md", { query: "?raw", import: "default", eager: true });
const pageFiles = import.meta.glob<string>("/src/content/pages/*.md", {
  query: "?raw",
  import: "default",
  eager: true,
});

export interface PostFrontmatter {
  templateKey?: string;
  title: string;
  // ISO strings, as Gatsby turned YAML dates into strings.
  date: string;
  updated?: string;
  author?: string;
  authorimage?: string;
  category?: string;
  topic?: string;
  illustration?: number;
  featuredimage?: string;
  featuredauthor?: string;
  featuredlink?: string;
  description?: string;
  tags?: string[];
}

export interface Post {
  slug: string;
  frontmatter: PostFrontmatter;
  body: string;
}

// The shape the article cards and the Articles page read (Gatsby's
// ArticleSummary fragment): small enough to hand to the browser.
export interface ArticleSummary {
  id: string;
  timeToRead: number;
  excerpt: string;
  fields: { slug: string };
  frontmatter: {
    title: string;
    date: string;
    description?: string;
    topic?: string;
    illustration?: number;
    tags?: string[];
  };
}

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

// Gatsby's `formatString: "MMMM DD, YYYY"`, in UTC.
export const formatDate = (iso: string): string => {
  const date = new Date(iso);
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${MONTHS[date.getUTCMonth()]} ${day}, ${date.getUTCFullYear()}`;
};

const toJson = (data: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(data).map(([key, value]) => [key, value instanceof Date ? value.toJSON() : value]));

const parse = (raw: string) => {
  const { data, content } = matter(raw);
  return { frontmatter: { title: "", ...toJson(data) }, body: content };
};

// An article dated after today is scheduled: the production build leaves it
// out until its day, and a daily rebuild (.github/workflows/publish.yml)
// publishes it. Deploy previews, CI and the dev server show it, so it can be
// reviewed before it goes out. scripts/published.mjs holds the same rule.
const hidesScheduled = process.env.CONTEXT === "production";
// By day, in UTC: an article dated today is out all day, whatever its hour.
const endOfToday = new Date().setUTCHours(23, 59, 59, 999);
const scheduled = (date: string) => hidesScheduled && Date.parse(date) > endOfToday;

const fileName = (path: string) => path.slice(path.lastIndexOf("/") + 1, -".md".length);

const allPosts: Post[] = Object.entries(postFiles)
  .map(([path, raw]) => {
    const { frontmatter, body } = parse(raw);
    return { slug: `/blog/${fileName(path)}/`, frontmatter: frontmatter as PostFrontmatter, body };
  })
  .filter((post) => post.frontmatter.templateKey === "blog-post")
  .filter((post) => !scheduled(post.frontmatter.date))
  .sort((a, b) => Date.parse(b.frontmatter.date) - Date.parse(a.frontmatter.date));

// Newest first.
export const getPosts = (): Post[] => allPosts;

export const getPost = (slug: string): Post | undefined => allPosts.find((post) => post.slug === slug);

export const summarize = async (post: Post): Promise<ArticleSummary> => {
  const { timeToRead, excerpts } = await renderMarkdown(post.body);
  const { title, date, description, topic, illustration, tags } = post.frontmatter;
  return {
    id: post.slug,
    timeToRead,
    excerpt: excerpts[200],
    fields: { slug: post.slug },
    frontmatter: { title, date: formatDate(date), description, topic, illustration, tags },
  };
};

export const summarizeAll = (posts: Post[]): Promise<ArticleSummary[]> => Promise.all(posts.map(summarize));

export const tagPath = (tag: string) => `/tags/${kebabCase(tag)}/`;

// Every tag with its number of posts, in the order the Tags page lists them:
// most used first, alphabetical among equals (Gatsby's group order).
export const getTags = (): { tag: string; count: number }[] => {
  const counts = new Map<string, number>();
  allPosts.forEach((post) => post.frontmatter.tags?.forEach((tag) => counts.set(tag, (counts.get(tag) ?? 0) + 1)));
  return [...counts.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count);
};

// An article's related posts share a tag with it other than "Development",
// which every post has; the three sharing the most come first, the newest
// breaking ties.
export const getRelated = (post: Post): Post[] => {
  const tags = (post.frontmatter.tags ?? []).filter((tag) => tag !== "Development");
  if (tags.length === 0) return [];
  return allPosts
    .filter((candidate) => candidate !== post && candidate.frontmatter.tags?.some((tag) => tags.includes(tag)))
    .slice(0, 30)
    .map((candidate, index) => ({
      candidate,
      index,
      shared: (candidate.frontmatter.tags ?? []).filter((tag) => tags.includes(tag)).length,
    }))
    .sort((a, b) => b.shared - a.shared || a.index - b.index)
    .slice(0, 3)
    .map(({ candidate }) => candidate);
};

export interface PageContent {
  frontmatter: Record<string, string | undefined>;
  body: string;
}

// The home page's title and subheading, and the About page (src/content/pages).
export const getPage = (name: "home" | "about"): PageContent => {
  const raw = pageFiles[`/src/content/pages/${name}.md`];
  if (!raw) throw new Error(`Missing src/content/pages/${name}.md`);
  const { frontmatter, body } = parse(raw);
  return { frontmatter: frontmatter as Record<string, string | undefined>, body };
};

// How the lists of articles receive them (Gatsby's `edges { node }`).
export type ArticleSummaryEdge = { node: ArticleSummary };
