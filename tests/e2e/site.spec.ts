import { test, expect, article } from "./fixtures";

test.describe("navigation", () => {
  test("highlights the section of the page being read", async ({ page }) => {
    await page.goto(article);
    const nav = page.getByRole("navigation").first();
    await expect(page.getByRole("link", { name: "Articles" }).first()).toHaveClass(/text-accent/);
    await expect(nav).toBeVisible();
  });

  test("opens and closes the mobile menu", async ({ page, isMobile }) => {
    test.skip(!isMobile, "the menu button only shows on small screens");
    await page.goto("/");
    await page.getByRole("button", { name: "Open main menu" }).click();
    await page.getByRole("link", { name: "About" }).last().click();
    await expect(page).toHaveURL(/\/about\/$/);
    await expect(page.getByRole("button", { name: "Open main menu" })).toBeVisible();
  });

  test("switches to the dark theme and remembers it", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "Theme" }).click();
    await page.getByRole("option", { name: "Dark" }).click();
    await expect(page.locator("html")).toHaveClass(/dark/);
    await page.reload();
    await expect(page.locator("html")).toHaveClass(/dark/);
  });
});

test.describe("search", () => {
  test("finds an article and closes once it is followed", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "Search articles" }).click();
    await page.getByRole("searchbox", { name: "Search the articles" }).fill("solid");
    await page.getByRole("link", { name: "Introduction to S.O.L.I.D principles" }).click();
    await expect(page).toHaveURL(/introduction-to-solid-principles\/$/);
    await expect(page.getByRole("searchbox")).toBeHidden();
  });

  test("closes with Escape", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "Search articles" }).click();
    await expect(page.getByRole("searchbox")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("searchbox")).toBeHidden();
  });
});

test.describe("articles", () => {
  test("filters by topic and reveals the rest as the reader scrolls", async ({ page }) => {
    await page.goto("/blog/");
    const cards = page.locator("main a[href^='/blog/2']");
    await expect(cards).toHaveCount(9);
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await expect.poll(() => cards.count()).toBeGreaterThan(9);

    await page.getByRole("button", { name: /^Security/ }).click();
    await expect(page).toHaveURL(/\?topic=security$/);
  });

  test("copies a code block", async ({ page, context, browserName }) => {
    test.skip(browserName !== "chromium", "clipboard permissions are Chromium's");
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await page.goto(article);
    await page.locator(".gatsby-code-button").first().click();
    await expect(page.locator(".gatsby-code-button-toaster")).toBeVisible();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toContain("dotnet new web");
  });

  test("follows the reader in the table of contents", async ({ page, isMobile }) => {
    test.skip(isMobile, "the table of contents shows from lg up");
    await page.goto(article);
    const heading = page.locator("article h2[id]").nth(3);
    const id = await heading.getAttribute("id");
    // A section is current once its heading reaches the top of the window.
    await heading.evaluate((element) => element.scrollIntoView());
    await expect(page.locator(`.toc a.is-active[href$="#${id}"]`)).toBeVisible();
  });

  test("loads the comments once the reader asks for them", async ({ page }) => {
    let requested = false;
    page.on("request", (request) => {
      if (/disqus\.com\/embed\.js/.test(request.url())) requested = true;
    });
    await page.goto(article);
    await page.getByRole("heading", { name: "Comments" }).scrollIntoViewIfNeeded();
    expect(requested, "Disqus before consent").toBe(false);

    const embed = page.waitForRequest(/blouppy\.disqus\.com\/embed\.js/);
    await page.getByRole("button", { name: "Load comments" }).click();
    await embed;
  });
});

test("sends the contact form to Netlify Forms", async ({ page }) => {
  let posted = "";
  await page.route("/", (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    posted = route.request().postData() ?? "";
    return route.fulfill({ status: 200, body: "" });
  });
  await page.goto("/contact/");
  await page.getByLabel("Name").fill("Ada");
  await page.getByLabel("Email").fill("ada@example.com");
  await page.getByLabel("Message").fill("Hello");
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(page).toHaveURL(/\/contact\/thanks\/$/);
  expect(posted).toBe("form-name=contact&name=Ada&email=ada%40example.com&message=Hello");
});

test("answers an unknown page with the 404 page", async ({ page }) => {
  const response = await page.goto("/no-such-page/");
  expect(response?.status()).toBe(404);
  await expect(page.getByRole("heading", { name: "Page not found" })).toBeVisible();
});
