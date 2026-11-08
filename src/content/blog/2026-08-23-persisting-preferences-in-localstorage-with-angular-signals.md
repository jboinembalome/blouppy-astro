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

Most applications have a handful of choices that should survive a reload: the theme, the language, a sidebar the user collapsed. The first version is often one line in a click handler, `localStorage.setItem('theme', mode)`, and one line at startup to read it back. Then a user opens the app in a private window and the bootstrap throws, a stale value from an older release puts the app in a state no menu offers, and the prerendered page crashes because there is no `localStorage` on the server.

In this article, we will build a small pattern for these preferences with Angular signals: a signal initialised from storage, a write-back that cannot break the page, validation of what we read, syncing between tabs and a guard for prerendering. Then we will look at how Blouppy Starter keeps its theme and language, why its time zone lives on the server instead, and what must never go into `localStorage`.


## What belongs in localStorage
`localStorage` is a synchronous key-value store of strings, scoped to an origin and kept by the browser until someone clears it. That makes it a good fit for a preference that has three properties:

- **It belongs to the device.** A dark theme on a laptop at night says nothing about the phone in the morning.
- **The server never needs it.** If no request, e-mail or background job depends on the value, there is no reason to send it anywhere.
- **Losing it is harmless.** A cleared browser falls back to a default.

A value that misses one of these belongs elsewhere, like the time zone below.


## A signal backed by storage
We read the stored value once to initialise a signal and write the signal back when it changes. Components read the signal and never touch storage.

```ts
import { DestroyRef, effect, inject, Injectable, PLATFORM_ID, signal } from '@angular/core';
import { isPlatformBrowser } from '@angular/common';

const SIDEBAR_KEY = 'sidebar-collapsed';

@Injectable({ providedIn: 'root' })
export class SidebarPreference {
  private readonly _isBrowser = isPlatformBrowser(inject(PLATFORM_ID));

  public readonly collapsed = signal<boolean>(this._isBrowser ? read() : false);

  constructor() {
    effect(() => write(this.collapsed()));

    if (!this._isBrowser) {
      return;
    }

    const onStorage = (event: StorageEvent): void => {
      if (event.key === SIDEBAR_KEY) {
        this.collapsed.set(parse(event.newValue));
      }
    };

    window.addEventListener('storage', onStorage);
    inject(DestroyRef).onDestroy(() => window.removeEventListener('storage', onStorage));
  }
}

function parse(raw: string | null): boolean {
  return raw === 'true';
}

function read(): boolean {
  try {
    return parse(localStorage.getItem(SIDEBAR_KEY));
  } catch {
    return false;
  }
}

function write(collapsed: boolean): void {
  try {
    localStorage.setItem(SIDEBAR_KEY, String(collapsed));
  } catch {
    // The preference only lasts for this session.
  }
}
```

Four details carry the pattern:

- **`try`/`catch` around every access.** `getItem` and `setItem` can throw: some browsers block storage in private browsing or when site data is disabled, and `setItem` throws a `QuotaExceededError` when the origin is full. A preference is never worth a broken page, so a failed read returns the default and a failed write is ignored.
- **Parsing at the boundary.** Storage holds strings, and anything can be in there: a value from an older release, a typo made in the developer tools, another library using the same key. `parse` turns the raw string into a valid value or the default, so the rest of the app only ever sees a `boolean`.
- **The `storage` event.** The browser fires it in the *other* documents of the same origin when one of them changes a key, never in the one that wrote it. Listening to it keeps two tabs in agreement: collapse the sidebar in one, and the other follows. `event.key` is `null` when storage was cleared entirely, so a stricter version would reset to the default in that case too.
- **`isPlatformBrowser`.** During server-side rendering or prerendering, there is no user's storage to read and no window to listen on, so the service starts on the default and touches nothing.

The `effect` also runs once on creation and writes back the value it just read, which is harmless. For an object, `JSON.parse` goes inside the same `try`, followed by a check of the shape: a successful parse does not make a valid value.


## Effect or explicit write
An `effect` persists every `set()` or `update()` without anyone remembering to. In exchange, the write happens later, when effects run, and a value that arrived through the `storage` event is written back once. That write changes nothing, so the browser fires no new event, but it is a loop worth knowing about.

The alternative is a private writable signal and a setter that persists explicitly. It is a few more lines, and it makes the write visible at the one place the value changes. Blouppy Starter takes this route.


## The real example: theme and language in Blouppy Starter
In [Blouppy Starter](https://starter.blouppy.com/), the theme is owned by `ThemeService` in the shared UI library. We covered how it applies the scheme in [runtime theming with CSS tokens and Tailwind 4](/blog/2026-06-27-runtime-theming-with-css-tokens-and-tailwind-4/); here we only look at storage:

```ts
export type ThemeMode = 'light' | 'dark' | 'system';

export const BLOUPPY_THEME_STORAGE_KEY = new InjectionToken<string>('BLOUPPY_THEME_STORAGE_KEY', {
  factory: () => 'blouppy-theme',
});

@Injectable({ providedIn: 'root' })
export class ThemeService {
  private readonly _isBrowser = isPlatformBrowser(inject(PLATFORM_ID));
  private readonly _storageKey = inject(BLOUPPY_THEME_STORAGE_KEY);

  public readonly mode = signal<ThemeMode>('system');

  constructor() {
    if (!this._isBrowser) {
      return;
    }

    this.mode.set(this.read() ?? 'system');
    this.apply();
  }

  public setMode(mode: ThemeMode): void {
    this.mode.set(mode);

    if (this._isBrowser) {
      try {
        localStorage.setItem(this._storageKey, mode);
      } catch {
        /* the choice simply does not outlive the session */
      }
    }

    this.apply();
  }

  private read(): ThemeMode | null {
    try {
      const saved = localStorage.getItem(this._storageKey);
      return saved === 'light' || saved === 'dark' || saved === 'system' ? saved : null;
    } catch {
      return null;
    }
  }
}
```

The key is an `InjectionToken` so each app of the Starter provides its own (the application uses `darkMode`) and the marketing site never re-themes the product. `read()` accepts the three modes and nothing else.

The language is held by `LanguageService` in the application, with one twist: it is needed **before** the injector exists, to seed `LOCALE_ID` and Transloco's default language. So the read is a plain function, called once at bootstrap:

```ts
export function resolveInitialLanguage(): AppLanguage {
  const persisted = readPersistedLanguage();
  if (persisted !== null) {
    return persisted;
  }

  const browserLanguage = typeof navigator !== 'undefined' ? navigator.language?.split('-')[0] : undefined;

  return isAppLanguage(browserLanguage) ? browserLanguage : DEFAULT_LANGUAGE;
}

export function readPersistedLanguage(): AppLanguage | null {
  try {
    const stored = localStorage.getItem(LANGUAGE_STORAGE_KEY);
    return isAppLanguage(stored) ? stored : null;
  } catch {
    return null;
  }
}
```

The order is the persisted choice, then the browser's language, then English. `isAppLanguage` is a type guard over the list of shipped languages, so a stored `de` from a translation that was later removed falls through to the next option. The service then starts its signal from the same function and persists only on a change:

```ts
@Injectable({ providedIn: 'root' })
export class LanguageService {
  private readonly _language = signal<AppLanguage>(resolveInitialLanguage());

  public readonly language = this._language.asReadonly();
  public readonly locale = computed(() => localeOf(this._language()));

  public setLanguage(language: AppLanguage): void {
    if (this._language() === language) {
      return;
    }

    this._language.set(language);
    this.persist(language);
    this.applyLanguage(language);
  }
}
```

Components read `language` and `locale`; only `setLanguage` writes. Neither service listens to the `storage` event: a second tab picks up the new theme or language on its next load. For two preferences that change rarely, that is a fair trade.

One more place shows the "per device" decision. On sign-out, an expired session or an account erasure, the app's `ClientDataPurgeService` removes what the browser remembers about the user, such as the current organization. The theme and the language are deliberately left out of that list: they belong to the device, and the next person on it expects them to stay.


## Why the time zone is on the server
The account preferences page offers three choices: language, theme and time zone. Only the first two are in `localStorage`. The time zone is a row in the `Users` domain, `UserSettings.TimeZoneId`, defaulting to `UTC`.

The test from the first section explains it. The server needs the time zone when no browser is open: the notification dispatcher reads the recipient's zone to decide whether an e-mail falls in their quiet hours.

```csharp
private async Task<TimeZoneInfo> GetTimeZoneAsync(UserId recipientId, CancellationToken cancellationToken)
{
    var timeZoneId = await usersPublicDataService.GetTimeZoneIdAsync(recipientId, cancellationToken);

    return TimeZoneInfo.TryFindSystemTimeZoneById(timeZoneId, out var timeZone)
        ? timeZone
        : TimeZoneInfo.Utc;
}
```

A value in `localStorage` would never reach that code. The language and the theme fail the opposite way: stored on the user, the phone and the laptop would fight over one value, and every change on one device would repaint the other. The rule we use is whether anything outside this browser has to honour the value. If yes, it is a user setting on the server; if no, it stays on the device.


## Never store tokens there
Any script running on the origin can read `localStorage`. One cross-site scripting hole or one compromised dependency can read every key and send it elsewhere, and nothing expires it. That is fine for `dark` and `fr`, not for an access or refresh token, which lets whoever holds it act as the user, nor for personal data. In Blouppy Starter, the browser holds no token at all: the gateway keeps them in an HTTP-only cookie session, as described in [keeping the access token out of the browser](/blog/2026-05-10-keep-the-access-token-out-of-the-browser-bff-angular-yarp/).


## When this is too much
The full pattern pays off for a preference read in many places, kept across tabs, or rendered on the server. For a single flag read by one component in an app that never prerenders, a `signal` initialised from a guarded `getItem` and a guarded `setItem` in the click handler is enough. Skip the `storage` listener when a stale second tab costs nothing, as with the Starter's theme and language.

Some costs stay whatever the size:

- **The storage is synchronous**, on the main thread: a few short strings, not lists or cached data.
- **There is no schema.** A renamed key or a changed format needs a fallback in `parse`, because old values stay in browsers indefinitely.
- **A flash on prerendered pages.** The server renders the default and the browser corrects it after hydration, unless a small inline script applies the theme before the first paint.
- **Tests share a storage.** Each spec should clear it, or one test's value leaks into the next.


## Conclusion
A preference in `localStorage` is a signal with a guarded read, a guarded write and a parser in between. Add the `storage` event when tabs must agree and `isPlatformBrowser` when the code also runs on the server. Blouppy Starter keeps exactly the values that pass the test, the theme and the language, on the device, and puts the time zone on the server because e-mails and background work depend on it. Tokens and personal data stay out of the browser's storage altogether.


## References
- [Window: localStorage property (MDN)](https://developer.mozilla.org/docs/Web/API/Window/localStorage) — the API and the exceptions it can throw.
- [Window: storage event (MDN)](https://developer.mozilla.org/docs/Web/API/Window/storage_event) — when other documents are notified of a change.
- [Storage quotas and eviction criteria (MDN)](https://developer.mozilla.org/docs/Web/API/Storage_API/Storage_quotas_and_eviction_criteria) — how much an origin can store and what happens when it is full.
- [Signals (Angular)](https://angular.dev/guide/signals) — `signal`, `computed` and `effect`.
- [isPlatformBrowser (Angular)](https://angular.dev/api/common/isPlatformBrowser) — the platform check used during server rendering.
- [HTML5 Security Cheat Sheet (OWASP)](https://cheatsheetseries.owasp.org/cheatsheets/HTML5_Security_Cheat_Sheet.html#local-storage) — why sensitive data does not belong in local storage.
- [TimeZoneInfo.TryFindSystemTimeZoneById (Microsoft Learn)](https://learn.microsoft.com/dotnet/api/system.timezoneinfo.tryfindsystemtimezonebyid) — resolving a stored zone id on the server.
