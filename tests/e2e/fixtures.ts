import { test as base, expect, type Page } from "@playwright/test";

export const article = "/blog/2026-05-10-keep-the-access-token-out-of-the-browser-bff-angular-yarp/";

// One hit for any query, shaped like Algolia's multi-query response.
const algoliaResponse = (body: { requests?: { indexName: string; query?: string }[] }) => ({
  results: (body.requests ?? []).map((request) => {
    const query = request.query ?? "";
    const hits = query
      ? [
          {
            objectID: "/blog/2022-02-28-introduction-to-solid-principles/",
            slug: "/blog/2022-02-28-introduction-to-solid-principles/",
            title: "Introduction to S.O.L.I.D principles",
            excerpt: "SOLID is an acronym",
            _highlightResult: {
              title: { value: "Introduction to S.O.L.I.D principles", matchLevel: "none", matchedWords: [] },
            },
            _snippetResult: { excerpt: { value: "SOLID is an acronym", matchLevel: "none" } },
          },
        ]
      : [];
    return {
      hits,
      nbHits: hits.length,
      page: 0,
      nbPages: 1,
      hitsPerPage: 20,
      processingTimeMS: 1,
      query,
      params: "",
      index: request.indexName,
      exhaustiveNbHits: true,
    };
  }),
});

type Consent = { analytics: boolean } | null;

// Every test: no third party (they are not ours to test), Algolia answered
// locally, and neither a script error nor a Content Security Policy violation.
// The cookie choice is made beforehand (everything refused), so the banner
// stays out of the way; the consent tests set `consent` to null to see it.
export const test = base.extend<{ page: Page; consent: Consent }>({
  consent: [{ analytics: false }, { option: true }],
  page: async ({ page, consent }, use) => {
    if (consent) {
      await page.addInitScript(
        (choice) => localStorage.setItem("blouppy-consent", JSON.stringify({ ...choice, at: Date.now() })),
        consent,
      );
    }
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.addInitScript(() => {
      (window as unknown as { __csp: string[] }).__csp = [];
      document.addEventListener("securitypolicyviolation", (event) =>
        (window as unknown as { __csp: string[] }).__csp.push(`${event.effectiveDirective} ${event.blockedURI}`),
      );
    });
    await page.route(/buymeacoffee|giscus|googletagmanager|google-analytics/, (route) => route.abort());
    await page.route(/algolia/, (route) =>
      route.fulfill({ json: algoliaResponse(JSON.parse(route.request().postData() ?? "{}")) }),
    );

    await use(page);

    const violations = await page
      .evaluate(() => (window as unknown as { __csp?: string[] }).__csp ?? [])
      .catch(() => []);
    expect(violations, "Content Security Policy violations").toEqual([]);
    expect(errors, "script errors").toEqual([]);
  },
});

export { expect };
