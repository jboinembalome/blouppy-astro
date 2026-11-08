// A static server for dist/, for the end-to-end tests: it answers like Netlify
// for what the tests rely on (directory indexes, 404.html with a 404, the
// contact form's POST). `astro preview` can detach into the background, which
// Playwright's webServer cannot wait for.
import { createServer } from "node:http";
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, join, normalize } from "node:path";

const root = "dist";
const port = Number(process.env.PORT ?? 4321);
const types = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
  ".xml": "application/xml",
  ".txt": "text/plain",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".pdf": "application/pdf",
};

createServer((request, response) => {
  if (request.method === "POST") {
    response.writeHead(200).end();
    return;
  }
  const path = normalize(decodeURIComponent(new URL(request.url ?? "/", "http://localhost").pathname));
  let file = join(root, path);
  if (existsSync(file) && statSync(file).isDirectory()) file = join(file, "index.html");
  if (!existsSync(file)) {
    response.writeHead(404, { "content-type": types[".html"] }).end(readFileSync(join(root, "404.html")));
    return;
  }
  response
    .writeHead(200, { "content-type": types[extname(file)] ?? "application/octet-stream" })
    .end(readFileSync(file));
}).listen(port, () => console.log(`dist/ served at http://localhost:${port}/`));
