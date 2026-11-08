// The articles the build publishes, for the scripts that read the Markdown
// files directly. Same rule as src/lib/posts.ts: on the production build, an
// article dated after today waits for its day.
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import matter from "gray-matter";

const folder = "src/content/blog";
const hidesScheduled = process.env.CONTEXT === "production";
const endOfToday = new Date().setUTCHours(23, 59, 59, 999);

export const publishedPosts = async () => {
  const files = (await readdir(folder)).filter((file) => file.endsWith(".md"));
  const posts = await Promise.all(
    files.map(async (file) => {
      const { data, content } = matter(await readFile(join(folder, file), "utf8"));
      return { file, data, content, slug: `/blog/${file.slice(0, -".md".length)}/` };
    }),
  );
  return posts.filter(
    ({ data }) => data.templateKey === "blog-post" && !(hidesScheduled && new Date(data.date).getTime() > endOfToday),
  );
};
