import { defineConfig, devices } from "@playwright/test";

// The end-to-end tests run against the built site (npm run build first),
// served as Netlify serves it (scripts/serve-dist.mjs), not the dev server.
export default defineConfig({
  testDir: "tests/e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["github"], ["list"]] : "list",
  use: {
    baseURL: "http://localhost:4321",
    trace: "off",
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"] } },
    { name: "mobile", use: { ...devices["Pixel 7"] } },
  ],
  webServer: {
    command: "node scripts/serve-dist.mjs",
    url: "http://localhost:4321/",
    reuseExistingServer: !process.env.CI,
  },
});
