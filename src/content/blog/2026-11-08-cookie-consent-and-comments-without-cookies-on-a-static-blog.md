---
templateKey: 'blog-post'
title: 'Cookie consent on a static blog, and comments without cookies'
date: 2026-11-08T18:00:00.000Z
author: Jimmy Boinembalome
authorimage: /img/jimmy.jpg
category: Astro
topic: 'Security'
illustration: 2
categorycolor: bg-orange-100 text-orange-800
featuredpost: true
description: >-
  Measure the cookies a static site really sets, ask before loading Google Analytics with a small consent store and banner, and replace Disqus with Giscus so the comments need no consent at all.
tags:
  - Development
  - Astro
  - Security
  - Privacy
  - Playwright
---

This blog loaded Google Analytics and Disqus on every page, before the reader had a say. It is a static site, with no account and no form apart from the contact page, so it is easy to think the cookie rules are for shops and SaaS products. They are not: they apply to any tracker that a site places in a reader's browser.

In this article, we will measure what the pages actually stored, see what the rules ask of a blog, add a consent banner for Google Analytics, and replace Disqus with Giscus, which needs no consent at all.


## What the pages actually set
Before changing anything, we listed the cookies a reader gets. A short Playwright script opens an article on the production site, scrolls to the comments, then prints every cookie of the browser context, whichever domain set it:

```ts
const context = await browser.newContext();
const page = await context.newPage();
await page.goto("https://blouppy.com/blog/2026-05-10-keep-the-access-token-out-of-the-browser-bff-angular-yarp/");
await page.getByRole("heading", { name: "Comments" }).scrollIntoViewIfNeeded();
await page.waitForTimeout(5000);
console.table((await context.cookies()).map(({ name, domain }) => ({ name, domain })));
```

The result, per service:

| Service | Cookies |
| --- | --- |
| Google Analytics | `_ga` and `_ga_<id>`, on the site's own domain |
| Disqus | about twenty, most of them from ad networks Disqus loads |
| Buy Me a Coffee (the donation widget) | none |
| Algolia (the search) | none |

Disqus was the surprise. The comments themselves are free because the embed carries advertising and tracking, and a reader who only scrolls to the end of an article gets all of it. Testing the site's Content Security Policy had already caught one of its scripts, an ad tracker, being injected into the host page.


## What the rules ask
In the European Union, the ePrivacy directive (article 5(3)) requires consent before anything is stored in, or read from, the reader's device, unless it is strictly necessary for a service the reader asked for. In France, the CNIL's guidelines and recommendation spell out what that means in practice:

- Nothing that needs consent loads before the reader chooses.
- Refusing is as easy as accepting: same place, same weight, one click.
- The reader can withdraw their consent at any time, as easily as they gave it.
- The choice, a refusal included, is remembered, and the CNIL recommends asking again after six months.

Audience measurement has an exemption, but only for a tool configured within strict limits (anonymous statistics for the site alone, no cross-site tracking, limited lifetime). Google Analytics as this blog uses it does not fit those limits, so there were two options: switch to an exempt tool, or ask. We kept Google Analytics and ask.

Disqus needed consent too. Putting it behind the same banner would work, but a reader who refuses would see no comments at all. That is what led to replacing it, further down.


## A consent store with no framework
The site is made of Astro pages with a few React islands. The choice is read by an island (the banner), by a plain module that runs on every page (it starts Analytics), and by a button in the footer. So the store is a small module of its own, with a `subscribe` function that React can use through `useSyncExternalStore`:

```ts
// src/lib/consent.ts
export interface Consent {
  analytics: boolean;
  at: number;
}

const storageKey = "blouppy-consent";
const maxAge = 1000 * 60 * 60 * 24 * 182; // six months

const read = (): Consent | null => {
  try {
    const value = JSON.parse(localStorage.getItem(storageKey) ?? "null") as Consent | null;
    return value && Date.now() - value.at < maxAge ? value : null;
  } catch {
    return null;
  }
};

export const saveConsent = (choice: Pick<Consent, "analytics">) => {
  current = { ...choice, at: Date.now() };
  try {
    localStorage.setItem(storageKey, JSON.stringify(current));
  } catch {
    // A browser that refuses storage asks again on the next page.
  }
  settingsOpen = false;
  applyConsent(current);
  emit();
};
```

The choice itself sits in `localStorage`. Storing it is strictly necessary to respect it, so it needs no consent of its own. A choice older than six months reads as no choice, and the banner shows again.

The React side is three one-line hooks. The server render has no `localStorage`, so it sees "already decided": the banner is not in the static HTML, and it appears only once the island runs in a browser that has no choice yet.

```ts
// src/components/consent/useConsent.ts
export const useConsent = () => useSyncExternalStore(subscribe, getConsent, () => null);
export const useConsentSettingsOpen = () => useSyncExternalStore(subscribe, isSettingsOpen, () => false);
export const useHasDecided = () => useSyncExternalStore(subscribe, () => getConsent() !== null, () => true);
```


## Loading Analytics only after consent
Google Analytics used to be an inline snippet in the layout. It is now created by the site's own module, and only when the stored choice says yes. A module also suits the site's Content Security Policy: there is no inline script to hash.

```ts
const loadAnalytics = () => {
  window[`ga-disable-${site.analyticsId}`] = false;
  if (analyticsLoaded) return;
  analyticsLoaded = true;
  window.dataLayer = window.dataLayer || [];
  window.gtag = function gtag() {
    // gtag.js reads the arguments object itself, not an array.
    window.dataLayer.push(arguments);
  };
  window.gtag("js", new Date());
  window.gtag("config", site.analyticsId);
  const script = document.createElement("script");
  script.async = true;
  script.src = `https://www.googletagmanager.com/gtag/js?id=${site.analyticsId}`;
  document.head.appendChild(script);
};
```

`gtag` must push the `arguments` object, not an array of the arguments: a rest parameter looks equivalent and silently records nothing.

Withdrawing is the half that is easy to forget. The script cannot be unloaded from a running page, but Google Analytics honours a `ga-disable-<id>` flag on `window`, and the cookies it already set can be deleted. They live on the registrable domain, so each one is expired with and without a `domain` attribute:

```ts
const stopAnalytics = () => {
  window[`ga-disable-${site.analyticsId}`] = true;
  const domain = window.location.hostname.split(".").slice(-2).join(".");
  document.cookie.split(";").forEach((cookie) => {
    const name = cookie.split("=")[0].trim();
    if (name === "_ga" || name.startsWith("_ga_") || name === "_gid") {
      for (const scope of ["", `; domain=${domain}`, `; domain=.${domain}`]) {
        document.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/${scope}`;
      }
    }
  });
};
```

A module imported by the layout runs `applyConsent(getConsent())` on every page. A reader who accepted is counted on each page they open, starting with the one where they clicked "Accept".


## The banner
With one purpose left, the banner is two buttons of the same size, side by side. There is no "Accept" in a bright colour next to a grey link that hides the refusal two screens further:

```tsx
export const ConsentBanner = () => {
  const decided = useHasDecided();
  const settingsOpen = useConsentSettingsOpen();
  const consent = useConsent();

  if (decided && !settingsOpen) return null;

  return (
    <section aria-labelledby="consent-title" className="fixed …">
      <h2 id="consent-title">Cookies</h2>
      <p>
        With your consent, Blouppy uses Google Analytics to count visits, which sets cookies. You can change your
        mind at any time from the footer.
      </p>
      {consent && <p>You have {consent.analytics ? "accepted" : "refused"} audience measurement.</p>}
      <button type="button" className="btn-outline" onClick={() => saveConsent({ analytics: false })}>
        Refuse
      </button>
      <button type="button" className="btn" onClick={() => saveConsent({ analytics: true })}>
        Accept
      </button>
    </section>
  );
};
```

Withdrawing must be as easy as accepting, so the footer of every page has a "Cookie settings" button. The footer is server-rendered, not an island, so the button only carries a `data-consent-settings` attribute, and one delegated listener reopens the banner. The banner then says which choice stands.

The banner is a `section` with a heading, not a modal dialog: it does not trap the focus or block the page. A reader can read the article and never answer, and nothing loads.


## Comments with Giscus
[Giscus](https://giscus.app/) stores the comments of each page in a GitHub Discussion of a repository. The thread shows in an iframe served by giscus.app. Reading it stores nothing in the reader's browser. Writing needs a GitHub account: after signing in, the session is kept in the page's `localStorage` (`giscus-session`), which serves the action the reader asked for. No consent is needed, so the comments load as soon as they come into view, for every reader.

The setup takes a few minutes:

1. The repository must be public, with Discussions enabled (Settings, Features).
2. Install the [giscus GitHub app](https://github.com/apps/giscus) on that repository.
3. Create a category for the comments. The Announcements type is the one giscus recommends: only maintainers and giscus can then open a discussion.
4. On giscus.app, enter the repository and the category, pick how pages map to discussions, and copy the identifiers from the generated snippet.

We picked the `pathname` mapping: the first comment on an article creates a discussion named after its path. The old Disqus threads were not imported. Disqus can export them, but they would land in GitHub under the name of whoever imports them, not their authors', so we started from zero.

The generated snippet is a `<script>` tag with `data-` attributes. In a React island, the component creates the same element once the island has mounted. Hydrating it with `client:visible` means nothing is fetched until the reader reaches the end of the article:

```tsx
// src/components/article/ArticleComments.tsx
const themeOf = () => (document.documentElement.classList.contains("dark") ? "transparent_dark" : "light");

const Giscus = () => {
  const container = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const element = container.current;
    if (!element || element.querySelector("script, iframe")) return;

    const script = document.createElement("script");
    script.src = "https://giscus.app/client.js";
    script.async = true;
    script.crossOrigin = "anonymous";
    Object.entries({
      repo: giscus.repo,
      repoId: giscus.repoId,
      category: giscus.category,
      categoryId: giscus.categoryId,
      mapping: "pathname",
      reactionsEnabled: "1",
      inputPosition: "bottom",
      theme: themeOf(),
      lang: "en",
      loading: "lazy",
    }).forEach(([key, value]) => (script.dataset[key] = value));
    element.appendChild(script);

    // The theme menu switches the page's scheme without a reload.
    const observer = new MutationObserver(() => {
      const frame = element.querySelector<HTMLIFrameElement>("iframe.giscus-frame");
      frame?.contentWindow?.postMessage({ giscus: { setConfig: { theme: themeOf() } } }, "https://giscus.app");
    });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    return () => observer.disconnect();
  }, []);

  return <div ref={container} className="giscus" />;
};
```

Two details. The snippet offers `preferred_color_scheme`, which follows the system, but this site has its own theme menu: the component passes the site's theme instead, and posts a `setConfig` message to the iframe whenever the `dark` class of `<html>` changes. And `transparent_dark` lets the card behind the comments show through, so the dark thread matches the page.

`giscus.repoId` and `giscus.categoryId` are public identifiers, not secrets: they are in every page's HTML anyway.


## The Content Security Policy
The policy lists the hosts allowed to run scripts. The Disqus hosts went, `https://giscus.app` came in. The tests passed with that, but a check of the real page found a violation: `client.js` also adds a stylesheet, `giscus.app/default.css`, and `style-src` did not allow it.

```js
// astro.config.mjs
scriptDirective: {
  resources: ["'self'", "https://www.googletagmanager.com", "https://cdnjs.buymeacoffee.com", "https://giscus.app"],
},
styleDirective: { resources: ["'self'", "'unsafe-inline'", "https://giscus.app"] },
```

The browser tests block every third party, on purpose. So they cannot see what a third party loads in turn. When one of them changes, load a real page once, with the console open.


## Tests
The Playwright fixture already failed a test on any script error or CSP violation. It gained a `consent` option, set to "refused" by default, so the banner stays out of the way of the other tests:

```ts
type Consent = { analytics: boolean } | null;

export const test = base.extend<{ page: Page; consent: Consent }>({
  consent: [{ analytics: false }, { option: true }],
  page: async ({ page, consent }, use) => {
    if (consent) {
      await page.addInitScript(
        (choice) => localStorage.setItem("blouppy-consent", JSON.stringify({ ...choice, at: Date.now() })),
        consent,
      );
    }
    // … no third party, no script error, no CSP violation
    await use(page);
  },
});
```

The consent tests set it to `null` to meet the banner as a new reader would, and check what matters legally, not what the banner looks like:

```ts
test.describe("cookie consent", () => {
  test.use({ consent: null });

  test("loads no analytics before the reader chooses, nor after a refusal", async ({ page }) => {
    const requested: string[] = [];
    page.on("request", (request) => {
      if (/googletagmanager/.test(request.url())) requested.push(request.url());
    });
    await page.goto(article);
    const banner = page.getByRole("region", { name: "Cookies" });
    await expect(banner).toBeVisible();

    await banner.getByRole("button", { name: "Refuse" }).click();
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
});
```

A third test accepts, reopens the banner from the footer, refuses, and checks the stored choice. And the comments test checks that `giscus.app/client.js` is requested once the comments come into view, with no consent given.


## Conclusion
Start by measuring: the list of cookies a page really sets is shorter to get than an opinion on whether a blog needs a banner, and it may hold surprises, as Disqus did here. For what needs consent, the code is small: a store in `localStorage`, a module that loads the script only after a yes and cleans up after a no, a banner where refusing is one click, and a way back from every page. For what can do without consent, a tool that sets no tracker is often simpler than a banner: the comments now show for every reader, and the banner only asks one question.


## References
- [Directive 2002/58/EC (ePrivacy), article 5(3)](https://eur-lex.europa.eu/legal-content/EN/ALL/?uri=CELEX:32002L0058) — consent for storing or reading information on the reader's device.
- [CNIL: cookies and other trackers](https://www.cnil.fr/en/cookies-and-other-tracking-devices) — the guidelines, the recommendation, and the audience measurement exemption.
- [Giscus](https://giscus.app/) — configuration and the generated snippet.
- [Giscus advanced usage](https://github.com/giscus/giscus/blob/main/ADVANCED-USAGE.md) — the `setConfig` message to the iframe.
- [Disable Google Analytics](https://developers.google.com/tag-platform/devguides/privacy#turn_off_google_analytics) — the `ga-disable-<id>` flag.
- [useSyncExternalStore](https://react.dev/reference/react/useSyncExternalStore) — subscribing React to a store outside it.
- [Astro: client directives](https://docs.astro.build/en/reference/directives-reference/#client-directives) — `client:visible` and the others.
- [Playwright: BrowserContext.cookies](https://playwright.dev/docs/api/class-browsercontext#browser-context-cookies) — listing every cookie of a page.
- [Playwright fixtures](https://playwright.dev/docs/test-fixtures) — options and the extended `page`.
