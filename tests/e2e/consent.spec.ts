import { test, expect, article } from "./fixtures";

const analytics = /googletagmanager/;

test.describe("cookie consent", () => {
  test.use({ consent: null });

  test("loads no analytics before the reader chooses, nor after a refusal", async ({ page }) => {
    const requested: string[] = [];
    page.on("request", (request) => {
      if (analytics.test(request.url())) requested.push(request.url());
    });
    await page.goto(article);
    const banner = page.getByRole("region", { name: "Cookies" });
    await expect(banner).toBeVisible();

    await banner.getByRole("button", { name: "Refuse" }).click();
    await expect(banner).toBeHidden();
    await page.reload();
    await expect(page.getByRole("region", { name: "Cookies" })).toBeHidden();
    expect(requested).toEqual([]);
  });

  test("starts Analytics once accepted", async ({ page }) => {
    await page.goto(article);
    const request = page.waitForRequest(/googletagmanager\.com\/gtag\/js/);
    await page.getByRole("button", { name: "Accept" }).click();
    await request;
  });

  test("lets the reader change their mind from the footer", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "Accept" }).click();
    await page.getByRole("button", { name: "Cookie settings" }).click();
    const banner = page.getByRole("region", { name: "Cookies" });
    await expect(banner).toContainText("You have accepted audience measurement.");

    await banner.getByRole("button", { name: "Refuse" }).click();
    await expect(banner).toBeHidden();
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem("blouppy-consent") ?? "{}"))).toMatchObject({
      analytics: false,
    });
  });
});
