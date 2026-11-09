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

Angular ships its own internationalization, and it builds **one application per locale**. That is fast at runtime and checked at build time. It also means that changing language loads another build, and adding a locale means a new deployment target. A person who picks French on their account page gets a full reload.

For a signed-in SaaS application, where the language is a setting like the theme, that model fits badly. A runtime library such as Transloco fits better, at a price worth knowing.


## Compile time or runtime
With [`@angular/localize`](https://angular.dev/guide/i18n), translation happens when we build. `ng extract-i18n` collects the marked messages, a translator fills one file per locale, and `localize: true` writes `dist/en/`, `dist/fr/` and so on, with the text inlined in each bundle.

With [Transloco](https://jsverse.gitbook.io/transloco), there is one build. Templates hold keys, and the text arrives later as a JSON file:

```html
<!-- @angular/localize: the text is in the template, replaced at build time -->
<h1 i18n="@@workspaces.title">Workspaces</h1>

<!-- Transloco: a key, resolved at runtime from assets/i18n/<lang>.json -->
<h1>{{ 'workspaces.title' | transloco }}</h1>
```

Switching language fetches another file and re-renders the views. The page stays where it is, and adding a locale is dropping in a file.


## Loading the active language
In [Blouppy Starter](https://starter.blouppy.com/), everything about the language lives in `core/i18n/`. The loader is the whole "runtime" part: `getTranslation(lang)` returns `http.get(`assets/i18n/${lang}.json`)`. Then `provideI18n()` wires it up. Here it is, trimmed:

```ts
export function provideI18n(): EnvironmentProviders {
  registerLocaleData(localeFr, 'fr-FR');

  const initialLanguage = resolveInitialLanguage();

  return makeEnvironmentProviders([
    provideTransloco({
      config: { availableLangs: ['en', 'fr'], defaultLang: initialLanguage, reRenderOnLangChange: true },
      loader: TranslocoHttpLoader,
    }),
    { provide: LOCALE_ID, useValue: localeOf(initialLanguage) },
    provideAppInitializer(() => inject(TranslocoService).load(initialLanguage)),
  ]);
}
```

`resolveInitialLanguage()` runs before the injector exists, so it reads `localStorage` directly. It tries the person's stored choice, then the browser's language, then English. The initializer waits for the JSON file before the first render. Without it, the first frame paints raw keys and then swaps them for text.

Switching is `LanguageService.setLanguage()`. It writes a signal and `localStorage`, calls `setActiveLang` on Transloco, and updates `<html lang>` for screen readers.


## Strings built in TypeScript
The pipe covers templates. A menu built in TypeScript is the classic trap. Built once with `translate()`, it keeps the language it was built in. In a zoneless app a template only updates on a signal, so the labels must be signals. `translateSignal` returns one that re-emits on a switch, and a `computed()` rebuilds the menu:

```ts
private readonly editLabel = translateSignal('common.edit');
private readonly deleteLabel = translateSignal('common.delete');

public readonly menuItems = computed<UiMenuItem[]>(() => [
  { id: 'edit', label: this.editLabel(), command: () => this.edit() },
  { id: 'delete', label: this.deleteLabel(), command: () => this.delete() },
]);
```

One-shot text, such as a toast, can keep `TranslocoService.translate()`: it is read once, in the language active when it shows.


## Dates do not follow LOCALE_ID
Angular's `DatePipe` and `CurrencyPipe` read `LOCALE_ID`. That is a provider value, set once at bootstrap. After a switch to French, the text is French and the dates still say `Mar 14, 2026`. The built-in i18n never meets this, since each build has its own `LOCALE_ID`.

The Starter's `LocalizedDatePipe` reads the locale from `LanguageService` instead and calls `formatDate()`. It is impure, so it runs on every change detection, and a small memo keyed by locale and value keeps it cheap. `formatDate()` only knows locales whose data was registered, which is why `provideI18n()` calls `registerLocaleData`. Currencies and numbers have the same pipes.


## The component library has its own catalogues
`@blouppy/ui` writes text of its own: a paginator's "Next page", a toast's "Close". Those strings cannot be Transloco keys, because the landing page and the documentation site use the library without Transloco. So the library ships `en` and `fr` catalogues as TypeScript objects, typed by one `UiTranslations` interface. A key missing from the French catalogue is a compile error.

The app points the library at its language once, in `app.config.ts`, with `provideUiI18n()`. The locale is passed as a function read in a reactive context, so a switch relabels the components already on screen.


## Making a missing key fail
By default, Transloco renders a missing key as the key itself, and a spec that finds a button by role still passes. The Starter's specs import `provideTranslocoTesting()`. It loads the real catalogues and installs a missing handler that throws, so a template naming a key absent from `en.json` fails its spec. The specs run in English, so a separate spec checks that `en.json` and `fr.json` hold the same keys.


## Runtime or build-time translation?
Runtime translation has real costs:

- **No compile-time key check.** `'workspace.titel' | transloco` compiles. Tests catch only the keys a spec renders.
- **A request before the first paint.** On a switch, the views keep the old language until the new file arrives.
- **Two mechanisms.** Text goes through Transloco, dates and money through the localized pipes. `DatePipe` by habit gives a French page with English dates.
- **Whole catalogues.** Each language downloads in full. At about 1,300 lines, that is fine; a much larger app wants scoped, lazy-loaded translations.

`@angular/localize` is the better choice for **public, prerendered pages**, where each locale deserves its own URL and HTML for search engines. That is why the Starter's landing page and documentation site stay in English, outside this setup. It also wins when the first paint matters more than a switch, and it is one dependency fewer. Runtime translation pays off when the language is a user setting in a signed-in app, or when translators must ship a locale without a release.


## References
- [Angular internationalization](https://angular.dev/guide/i18n) — Angular: `@angular/localize` and one build per locale.
- [Transloco documentation](https://jsverse.gitbook.io/transloco) — jsverse: configuration, loaders and the `transloco` pipe.
- [Transloco: signals](https://jsverse.gitbook.io/transloco/core-concepts/signals) — jsverse: `translateSignal` and its re-emission on a switch.
- [LOCALE_ID](https://angular.dev/api/core/LOCALE_ID) — Angular: the locale token the built-in pipes read.
