import { test, expect, article } from "./fixtures";

const thirdParties = /googletagmanager|disqus\.com\/embed/;

test.describe("cookie consent", () => {
  test.use({ consent: null });

  test("loads nothing that sets cookies before the reader chooses, nor after a refusal", async ({ page }) => {
    const requested: string[] = [];
    page.on("request", (request) => {
      if (thirdParties.test(request.url())) requested.push(request.url());
    });
    await page.goto(article);
    const banner = page.getByRole("region", { name: "Cookies" });
    await expect(banner).toBeVisible();
    await page.getByRole("heading", { name: "Comments" }).scrollIntoViewIfNeeded();

    await banner.getByRole("button", { name: "Refuse", exact: true }).click();
    await expect(banner).toBeHidden();
    await page.reload();
    await expect(page.getByRole("region", { name: "Cookies" })).toBeHidden();
    expect(requested).toEqual([]);
  });

  test("starts Analytics and the comments once accepted", async ({ page }) => {
    await page.goto(article);
    const analytics = page.waitForRequest(/googletagmanager\.com\/gtag\/js/);
    const comments = page.waitForRequest(/blouppy\.disqus\.com\/embed\.js/);
    await page.getByRole("button", { name: "Accept" }).click();
    await analytics;
    await page.getByRole("heading", { name: "Comments" }).scrollIntoViewIfNeeded();
    await comments;
  });

  test("lets the reader choose per purpose, and change it from the footer", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "Choose" }).click();
    await page.getByRole("switch", { name: /Comments/ }).click();
    await page.getByRole("button", { name: "Save choices" }).click();
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem("blouppy-consent") ?? "{}"))).toMatchObject({
      analytics: false,
      comments: true,
    });

    await page.getByRole("button", { name: "Cookie settings" }).click();
    await expect(page.getByRole("switch", { name: /Comments/ })).toHaveAttribute("aria-checked", "true");
    await expect(page.getByRole("switch", { name: /Audience measurement/ })).toHaveAttribute("aria-checked", "false");
  });
});
