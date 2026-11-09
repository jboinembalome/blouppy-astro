---
templateKey: 'blog-post'
title: 'Persisting preferences in localStorage with Angular signals'
date: 2026-08-23T09:00:00.000Z
author: Jimmy Boinembalome
authorimage: /img/jimmy.jpg
category: Angular
topic: 'Front end'
illustration: 2
categorycolor: bg-red-100 text-red-800
featuredpost: true
description: >-
  Keep per-device preferences such as the theme or the language in localStorage with Angular signals: reading, validating, writing back safely, syncing tabs, prerendering, and what never goes there.
tags:
  - Development
  - Angular
  - TypeScript
---

Most applications have a few choices that should survive a reload: the theme, the language, a collapsed sidebar. The first version is one `localStorage.setItem('theme', mode)` in a click handler and one `getItem` at startup. Then a private window makes the bootstrap throw. A stale value from an older release puts the app in a state no menu offers. And the prerendered page crashes, because the server has no `localStorage`.

A small pattern with signals avoids all three.


## What belongs there
`localStorage` is a synchronous store of strings, per origin, kept until someone clears it. It fits a preference with three properties:

- **It belongs to the device.** A dark theme on a laptop at night says nothing about the phone in the morning.
- **The server never needs it.** No request, e-mail or background job depends on it.
- **Losing it is harmless.** A cleared browser falls back to a default.


## A signal backed by storage
We read the stored value once to start a signal, and write it back when it changes. Components read the signal and never touch storage:

```ts
const SIDEBAR_KEY = 'sidebar-collapsed';

@Injectable({ providedIn: 'root' })
export class SidebarPreference {
  private readonly isBrowser = isPlatformBrowser(inject(PLATFORM_ID));
  private readonly _collapsed = signal(this.isBrowser ? read() : false);

  public readonly collapsed = this._collapsed.asReadonly();

  public setCollapsed(collapsed: boolean): void {
    this._collapsed.set(collapsed);

    try {
      localStorage.setItem(SIDEBAR_KEY, String(collapsed));
    } catch {
      // The choice only lasts for this session.
    }
  }
}

function read(): boolean {
  try {
    return localStorage.getItem(SIDEBAR_KEY) === 'true';
  } catch {
    return false;
  }
}
```

Three details carry it. Every access sits in a `try`, because `getItem` and `setItem` can throw. Some browsers block storage in private browsing, and `setItem` throws `QuotaExceededError` when the origin is full. A preference is never worth a broken page.

Then the read **parses** what it finds. Storage can hold anything: a value from an older release, a typo made in the developer tools, another library's key. The parser returns a valid value or the default, so the app only sees a `boolean`. For an object, `JSON.parse` goes inside the same `try`, followed by a shape check: a successful parse is not a valid value.

Last, `isPlatformBrowser` keeps the server away. During prerendering there is no user's storage, so the service starts on the default.

An `effect(() => write(this.collapsed()))` could replace the setter and persist every change automatically. The explicit setter is a few more lines, but it makes the write visible at the one place the value changes.

To keep two tabs in agreement, listen to the `storage` event. The browser fires it in the *other* documents of the origin when one of them changes a key. The handler checks `event.key` and sets the signal from `event.newValue`, through the same parser.


## Theme and language in Blouppy Starter
[Blouppy Starter](https://starter.blouppy.com/) keeps two preferences this way. The theme lives in `ThemeService`, in the UI library, as described in [runtime theming with CSS tokens and Tailwind 4](/blog/2026-06-27-runtime-theming-with-css-tokens-and-tailwind-4/). Its key is an `InjectionToken`, so each app provides its own (the application uses `darkMode`) and the marketing site never re-themes the product. Its read accepts the three modes and nothing else:

```ts
private read(): ThemeMode | null {
  try {
    const saved = localStorage.getItem(this._storageKey);
    return saved === 'light' || saved === 'dark' || saved === 'system' ? saved : null;
  } catch {
    return null;
  }
}
```

The language has one twist: it is needed **before** the injector exists, to seed `LOCALE_ID` and Transloco. So the read is a plain function, `resolveInitialLanguage()`, called at bootstrap. It tries the stored choice, then the browser's language, then English. A type guard over the shipped languages makes a stored `de` from a removed translation fall through. `LanguageService` then starts its signal from the same function and persists only in `setLanguage`.

Neither service listens to the `storage` event: a second tab picks up the change on its next load. For two values that change rarely, that is a fair trade. And on sign-out, the app's `ClientDataPurgeService` clears what the browser remembers about the user, but leaves the theme and the language. They belong to the device, and the next person on it expects them to stay.


## Why the time zone is on the server
The account preferences page offers a third choice, the time zone, and it is not in `localStorage`. It is a row on the server, `UserSettings.TimeZoneId`. The second test explains it: the notification dispatcher reads the recipient's zone to decide whether an e-mail falls in their quiet hours, with no browser open.

The language and the theme fail the other way. Stored on the user, the phone and the laptop would fight over one value. So the rule is whether anything outside this browser has to honour the value. If yes, it is a user setting on the server. If no, it stays on the device.


## Never store tokens there
Any script on the origin can read `localStorage`. One cross-site scripting hole or one compromised dependency reads every key, and nothing expires them. That is fine for `dark` and `fr`. It is not for an access token, which lets whoever holds it act as the user, nor for personal data. In the Starter, the browser holds no token at all: the gateway keeps them in an HTTP-only cookie session, as in [keeping the access token out of the browser](/blog/2026-05-10-keep-the-access-token-out-of-the-browser-bff-angular-yarp/).

Two costs remain whatever the size. Storage has no schema, so a renamed key or format needs a fallback in the parser: old values stay in browsers indefinitely. And a prerendered page renders the default, so the theme flashes after hydration unless a small inline script applies it before the first paint.


## References
- [Window: localStorage property](https://developer.mozilla.org/docs/Web/API/Window/localStorage) — MDN: the API and the exceptions it can throw.
- [Window: storage event](https://developer.mozilla.org/docs/Web/API/Window/storage_event) — MDN: when other documents are notified of a change.
- [isPlatformBrowser](https://angular.dev/api/common/isPlatformBrowser) — Angular: the platform check used during server rendering.
- [HTML5 Security Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/HTML5_Security_Cheat_Sheet.html#local-storage) — OWASP: why sensitive data does not belong in local storage.
