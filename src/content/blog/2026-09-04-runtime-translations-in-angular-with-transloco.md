---
templateKey: 'blog-post'
title: 'Runtime translations in Angular with Transloco'
date: 2026-09-04T09:00:00.000Z
author: Jimmy Boinembalome
authorimage: /img/jimmy.jpg
category: Angular
topic: 'Front end'
illustration: 1
categorycolor: bg-red-100 text-red-800
featuredpost: true
description: >-
  Learn when to translate an Angular app at runtime with Transloco instead of @angular/localize, and how to switch language, dates and a component library without a reload.
tags:
  - Development
  - Angular
  - TypeScript
  - Transloco
---

Angular ships its own internationalization. We mark the templates with `i18n`, extract the messages, translate the XLIFF files, and the build produces **one application per locale**. It is fast at runtime and checked at build time. It also means that changing language is a navigation to another build, that adding a locale is a new build and a new deployment target, and that a person who picks French in their preferences gets a full page reload.

For a signed-in SaaS application, where the language is a setting on the account page like the theme, that model fits badly. In this article, we will compare the two approaches, set up **Transloco** to fetch the active language as a JSON file at runtime, make dates, menus and a component library follow a switch without a reload, and make a missing key fail a test. We will finish with what the runtime approach costs, and when the built-in one is the better choice.


## Two models of translation
With [`@angular/localize`](https://angular.dev/guide/i18n), translation happens at **compile time**. A template says:

```html
<h1 i18n="@@workspaces.title">Workspaces</h1>
```

`ng extract-i18n` collects every marked message into a source file, a translator fills one file per locale, and with `localize: true` in `angular.json` the build writes `dist/en/`, `dist/fr/` and so on. The translated text is inlined in each bundle. The server picks the folder from the URL or the `Accept-Language` header.

With a runtime library such as [Transloco](https://jsverse.gitbook.io/transloco), there is **one build**. The templates hold keys, and the text arrives later:

```html
<h1>{{ 'workspaces.title' | transloco }}</h1>
```

```json
{ "workspaces": { "title": "Workspaces" } }
```

The active language is a JSON file fetched over HTTP. Switching language fetches another file and re-renders the views; the page stays where it is.

|                     | `@angular/localize`             | Transloco                          |
| ------------------- | ------------------------------- | ---------------------------------- |
| Builds              | One per locale                  | One                                |
| Switching language  | Load another build              | Fetch a JSON file, re-render       |
| Adding a locale     | Rebuild, redeploy               | Drop in a file                     |
| Missing translation | Reported by the build           | Rendered as the key, unless tested |
| Prerendered pages   | One prerendered tree per locale | Default language until it loads    |


## Bootstrapping the active language
In [Blouppy Starter](https://starter.blouppy.com/), everything about the language lives in `core/i18n/`. `language.ts` declares what ships and how the first language is chosen:

```ts
export const APP_LANGUAGES = ['en', 'fr'] as const;

export type AppLanguage = (typeof APP_LANGUAGES)[number];

export const LANGUAGE_DEFINITIONS: readonly LanguageDefinition[] = [
  { code: 'en', label: 'English', locale: 'en-US', flag: 'US.svg' },
  { code: 'fr', label: 'Français', locale: 'fr-FR', flag: 'FR.svg' },
];

export function resolveInitialLanguage(): AppLanguage {
  const persisted = readPersistedLanguage();
  if (persisted !== null) {
    return persisted;
  }

  const browserLanguage = typeof navigator !== 'undefined' ? navigator.language?.split('-')[0] : undefined;

  return isAppLanguage(browserLanguage) ? browserLanguage : DEFAULT_LANGUAGE;
}
```

The persisted choice comes first, then the browser's language, then English. The choice is kept in `localStorage`, per device, like the theme in [runtime theming with CSS tokens](/blog/2026-06-27-runtime-theming-with-css-tokens-and-tailwind-4/). `readPersistedLanguage` catches the exception a private window can throw, so a blocked storage falls back to the browser's language instead of breaking the bootstrap.

The loader is the whole "runtime" part:

```ts
@Injectable({ providedIn: 'root' })
export class TranslocoHttpLoader implements TranslocoLoader {
  private readonly _http = inject(HttpClient);

  public getTranslation(lang: string): Observable<Translation> {
    return this._http.get<Translation>(`assets/i18n/${lang}.json`);
  }
}
```

`provideI18n()` wires Transloco, the locale data and an initializer:

```ts
export function provideI18n(): EnvironmentProviders {
  registerLocaleData(localeEn, 'en-US');
  registerLocaleData(localeFr, 'fr-FR');

  const initialLanguage = resolveInitialLanguage();

  return makeEnvironmentProviders([
    provideTransloco({
      config: {
        availableLangs: [...APP_LANGUAGES],
        defaultLang: initialLanguage,
        fallbackLang: DEFAULT_LANGUAGE,
        reRenderOnLangChange: true,
        prodMode: environment.production,
      },
      loader: TranslocoHttpLoader,
    }),
    { provide: LOCALE_ID, useValue: localeOf(initialLanguage) },
    provideAppInitializer(() => {
      inject(LanguageService).init();

      return inject(TranslocoService).load(initialLanguage);
    }),
  ]);
}
```

- `resolveInitialLanguage` runs **before the injector exists**, which is why it reads `localStorage` directly: it has to seed both Transloco's default language and `LOCALE_ID`.
- `reRenderOnLangChange: true` lets the pipe re-render on a switch.
- The initializer **waits for the JSON file** before the first render. Without it, the first frame paints raw keys (`workspaces.title`) and then swaps them for text.

Switching is `LanguageService.setLanguage`: a signal write, a `localStorage` write, `setActiveLang` on Transloco, and `<html lang>` updated for screen readers.


## Strings built in TypeScript
The pipe covers templates. A menu built in TypeScript is the classic trap: built once with `translate()`, it keeps the language it was built in. With [zoneless change detection](https://angular.dev/guide/zoneless), a template only updates on a signal, so the labels have to be signals too. Transloco's `translateSignal` returns one that re-emits on a switch, and a `computed()` over it rebuilds the menu. Here is a webhook's row menu, trimmed:

```ts
private readonly _editLabel = translateSignal('common.edit');
private readonly _pauseLabel = translateSignal('webhooks.pause');
private readonly _resumeLabel = translateSignal('webhooks.resume');

public readonly menuItems = computed<UiMenuItem[]>(() => {
  const webhook = this.webhook();

  return [
    { id: 'edit', label: this._editLabel(), icon: 'pi pi-pencil', command: () => this.edited.emit(webhook) },
    webhook.isActive
      ? { id: 'pause', label: this._pauseLabel(), icon: 'pi pi-pause', command: () => this.activeChanged.emit({ webhook, isActive: false }) }
      : { id: 'resume', label: this._resumeLabel(), icon: 'pi pi-play', command: () => this.activeChanged.emit({ webhook, isActive: true }) },
  ];
});
```

One-shot text, such as a toast, can keep `TranslocoService.translate()`: it is read once, in the language active when it is shown.


## Dates follow the language, not LOCALE_ID
Angular's `DatePipe` and `CurrencyPipe` read `LOCALE_ID`, and `LOCALE_ID` is a provider value: it is set once, at bootstrap, and never changes. After a switch to French, the text is French and the dates still say `Mar 14, 2026`. The built-in i18n never meets this problem, since each build has its own `LOCALE_ID`.

The Starter's `LocalizedDatePipe` reads the locale from `LanguageService` instead:

```ts
@Pipe({ name: 'localizedDate', pure: false })
export class LocalizedDatePipe implements PipeTransform {
  private readonly _languageService = inject(LanguageService);
  private readonly _cache = new Map<string, string | null>();

  public transform(value: Date | string | number | null | undefined, format = 'mediumDate', timezone?: string): string | null {
    if (value === null || value === undefined || value === '') {
      return null;
    }

    const locale = this._languageService.locale();
    const key = `${locale}|${format}|${timezone ?? ''}|${value instanceof Date ? value.getTime() : value}`;
    const cached = this._cache.get(key);

    if (cached !== undefined) {
      return cached;
    }

    const formatted = formatDate(value, format, locale, timezone);
    this._cache.set(key, formatted);

    return formatted;
  }
}
```

- It is **impure**, so it runs on every change detection, and the memo keyed by locale keeps that cheap. The real pipe also catches an unparsable value and clears the cache past 200 entries.
- `formatDate` only knows a locale whose data was registered, which is why `provideI18n()` calls `registerLocaleData` for every shipped language.
- `LocalizedCurrencyPipe` and `LocalizedNumberPipe` follow the same pattern. The native date input is a separate story: its format follows the browser, as described in [just use `<input type="date">`](/blog/2026-06-03-just-use-input-type-date-in-angular/).


## The component library has its own catalogues
`@blouppy/ui`, the Starter's component library, writes text of its own: a paginator's "Next page", a toast's "Close". Those strings cannot be Transloco keys, because the landing page, the documentation site and the playground use the library without Transloco. So it ships its own `en` and `fr` catalogues as TypeScript objects, typed by one interface:

```ts
export const UI_FR_TRANSLATIONS: UiTranslations = {
  dateRange: {
    from: 'Du',
    to: 'Au',
    clear: 'Effacer',
  },
  // ... one section per component that writes text
};
```

A component reads its section through `uiText('paginator')`, a `computed` over the active catalogue. The app points the library at its own language once, in `app.config.ts`:

```ts
provideUiI18n(() => {
  const language = inject(LanguageService).language;

  return { locale: () => language() };
}),
```

The locale is a function so that it is read inside a reactive context: a switch relabels the library's components that are already on screen. An app that configures nothing gets English, and an app that disagrees with a label overrides it through a `translations` function rather than forking the component. Since the catalogues are typed, a key missing from `fr.ts` is a compile error, which the JSON catalogues of the app cannot offer.


## Making a missing key fail a test
By default, Transloco renders a missing key as the key itself. Nobody reads `workspaces.emptyTitle` on a page during a unit test, and a spec that queries a button by role still finds it. The Starter's specs import `provideTranslocoTesting()`, which loads the **real** catalogues and replaces the missing handler:

```ts
class ThrowingMissingHandler implements TranslocoMissingHandler {
  handle(key: string): never {
    throw new Error(`Missing translation for key "${key}"`);
  }
}

export function provideTranslocoTesting(): ModuleWithProviders<TranslocoTestingModule> {
  const module = TranslocoTestingModule.forRoot({
    langs: { en, fr },
    translocoConfig: { availableLangs: ['en', 'fr'], defaultLang: 'en', reRenderOnLangChange: true },
    preloadLangs: true,
  });

  return {
    ...module,
    providers: [...(module.providers ?? []), { provide: TRANSLOCO_MISSING_HANDLER, useClass: ThrowingMissingHandler }],
  };
}
```

A template naming a key absent from `en.json` now fails its spec. The specs run in English, so a key missing only from `fr.json` goes unnoticed. Where a list of keys is computed, such as the audit log's event types, a spec walks both catalogues for every entry. A test comparing the key sets of `en.json` and `fr.json` is a cheap addition for the rest.


## What it costs
- **No compile-time key checking.** `'workspace.titel' | transloco` compiles. The tests catch the keys a spec renders, and only those.
- **A request before the first render.** The initializer trades the flash of raw keys for a short delay: the JSON file has to arrive before anything paints. On a switch, the views keep the old language until the new file is loaded.
- **Two locale mechanisms.** Text goes through Transloco; dates, numbers and currencies go through the localized pipes, because `LOCALE_ID` cannot follow. Using Angular's `DatePipe` by habit gives a page in French with English dates.
- **Whole catalogues.** Every language's catalogue is downloaded whole. At around 1,300 lines for the Starter's `en.json`, that is fine; a much larger app would want [scoped, lazy-loaded translations](https://jsverse.gitbook.io/transloco/advanced-features/lazy-load/scope-configuration).
- **Prerendered sites are not covered.** The landing page and the documentation site are prerendered. A runtime catalogue would serve their HTML in the default language and replace it after hydration, which defeats the point of prerendering. They stay in English, outside this setup.


## When the built-in i18n is enough
Runtime translation pays for itself when the language is a **user setting** in a signed-in application, when translators should be able to ship a locale without a release, or when one deployment has to serve every language from one URL.

`@angular/localize` is the better choice when the pages are **public and prerendered**, where each locale deserves its own URL and its own HTML for search engines; when the first paint matters more than a switch without reload; or when a build that reports missing translations is worth more than a locale added without a rebuild. It is also part of the framework: one fewer dependency to upgrade.

An application that ships in one language needs neither.


## Conclusion
Angular's built-in i18n translates at compile time and builds one application per locale. Transloco fetches the active language as a JSON file and builds once, which makes a language switch a signal write instead of a reload. The price: dates need their own pipe because `LOCALE_ID` stays fixed, menus built in TypeScript need `translateSignal`, and the tests have to check the keys the compiler no longer does.

This is how translation works in [Blouppy Starter](https://starter.blouppy.com/).


## References
- [Angular internationalization (angular.dev)](https://angular.dev/guide/i18n) — `@angular/localize`, `ng extract-i18n` and one build per locale.
- [Transloco documentation (jsverse)](https://jsverse.gitbook.io/transloco) — configuration, loaders and the `transloco` pipe.
- [Transloco: signals (jsverse)](https://jsverse.gitbook.io/transloco/core-concepts/signals) — `translateSignal` and its re-emission on a language switch.
- [Transloco: testing (jsverse)](https://jsverse.gitbook.io/transloco/advanced-features/unit-testing) — `TranslocoTestingModule` and preloaded languages.
- [Transloco: scope configuration (jsverse)](https://jsverse.gitbook.io/transloco/advanced-features/lazy-load/scope-configuration) — lazy-loaded catalogues for a large application.
- [LOCALE_ID (angular.dev)](https://angular.dev/api/core/LOCALE_ID) — the locale token the built-in pipes read.
- [formatDate (angular.dev)](https://angular.dev/api/common/formatDate) — the function behind `LocalizedDatePipe`.
- [Zoneless Angular (angular.dev)](https://angular.dev/guide/zoneless) — why the labels a template reads must be signals.
