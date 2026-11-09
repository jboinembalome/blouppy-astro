---
templateKey: 'blog-post'
title: 'Unit testing an Angular app with Vitest: zoneless TestBed, signals and jsdom'
date: 2026-09-16T09:00:00.000Z
author: Jimmy Boinembalome
authorimage: /img/jimmy.jpg
category: Angular
topic: 'Testing'
illustration: 3
categorycolor: bg-red-100 text-red-800
featuredpost: true
description: >-
  Learn how to run Angular 22 unit tests on Vitest with the CLI's unit-test builder: jsdom, a zoneless TestBed, signal inputs, HttpTestingController and vi.fn mocks.
tags:
  - Development
  - Angular
  - Testing
  - Vitest
---

For years, `ng test` meant Karma launching a real Chrome and Jasmine running the specs inside it. Karma is deprecated, the browser makes the suite slow to start, and an app without zone.js has no use for `fakeAsync`. The Angular CLI now ships a builder that runs the same specs on [Vitest](https://vitest.dev/), in Node, against a DOM emulated by [jsdom](https://github.com/jsdom/jsdom).

The examples come from [Blouppy Starter](https://starter.blouppy.com/), an Angular 22 app whose suite moved from Karma to Vitest.


## The builder
The test target of `angular.json` names the `@angular/build:unit-test` builder and Vitest as its runner. This is the Starter's:

```json
"test": {
  "builder": "@angular/build:unit-test",
  "options": {
    "tsConfig": "tsconfig.spec.json",
    "runner": "vitest",
    "runnerConfig": "vitest.config.ts",
    "coverage": true,
    "setupFiles": ["src/testing/setup-jsdom.ts"]
  }
}
```

The builder compiles the specs with the app's own build pipeline and bootstraps `TestBed`. There is no `test.ts` or `karma.conf.js` left. Adding `vitest/globals` to the `types` of `tsconfig.spec.json` makes `describe`, `it`, `expect` and `vi` available without an import.

`runnerConfig` points at a plain Vitest file for what the builder cannot express. The Starter keeps coverage thresholds there that fail the build: a modest floor for the app and stricter bars for the core services. It also keeps one workaround. Vitest externalises `node_modules`, and a CommonJS package loaded that way can hand its consumer a namespace instead of a callable default export. Every spec rendering the rich-text editor threw "tippy is not a function" until `server.deps.inline` listed `tippy.js` and `@tiptap/`. Expect a few such lines when migrating a suite with older dependencies.


## What jsdom lacks
jsdom implements the DOM and little of the browser around it. The setup file fills the gaps the app hits. `window.matchMedia`, called by the theme service, does not exist, so it is stubbed to "does not match". `canvas.getContext` returns `null` silently, which the chart already reads as "nothing to draw on".

The same file clears `localStorage` and `sessionStorage` before each spec file. That line came from a flaky suite. jsdom's storage is shared by the spec files of a worker, so a `fr` language left by one file started the next in French. A spec formatting a number then failed, in some orders only.


## A zoneless TestBed
Since Angular 21, zoneless is the default, `TestBed` included. Without zone.js, `fakeAsync`, `tick` and `waitForAsync` are gone, and plain `async`/`await` replaces them:

- `fixture.detectChanges()` still renders synchronously.
- `await fixture.whenStable()` waits until Angular has nothing pending, such as an HTTP request the component started.
- `TestBed.tick()` runs effects and change detection now, for a service with no fixture.
- Vitest's fake timers stand in for `tick(ms)`.

Here is a minimal component spec, with a signal input:

```ts
@Component({
  selector: 'app-greeting',
  template: `<h1>Hello {{ name() }}</h1>`,
})
class GreetingComponent {
  public readonly name = input.required<string>();
}

it('should greet by name', () => {
  // Arrange
  const fixture = TestBed.createComponent(GreetingComponent);
  fixture.componentRef.setInput('name', 'Ada');

  // Act
  fixture.detectChanges();

  // Assert
  expect(fixture.nativeElement.querySelector('h1').textContent).toContain('Ada');
});
```

A signal input has no `set` from outside. `componentRef.setInput()` goes through the same path as a parent's binding, so it works for `input()`, `input.required()` and `@Input()` alike. When the component loads data in reaction to an input, the spec adds `await fixture.whenStable()` after `detectChanges()`.

A service whose state is signals is tested by reading them. One catch: `toObservable` and `effect` only run when Angular flushes them. The Starter's `WorkspaceService` reloads its list when the current organization changes, through `toObservable`. Its spec fakes the organization service with a real `signal()`, sets it, and calls `TestBed.tick()` before asserting. Without that call, the assertion runs before the effect and sees the old list. A real signal is also simpler to fake than a mocked getter.


## Mocks with vi.fn
Jasmine's `createSpyObj` has no direct equivalent, and none is needed. A mock is an object literal of `vi.fn()`, typed with `MockedObject<Pick<…>>` so it can only fake members that exist:

```ts
let toastService: MockedObject<Pick<UiToastService, 'success' | 'danger'>>;

beforeEach(() => {
  toastService = {
    success: vi.fn().mockName('UiToastService.success'),
    danger: vi.fn().mockName('UiToastService.danger'),
  };

  TestBed.configureTestingModule({
    providers: [UiClipboardService, { provide: UiToastService, useValue: toastService }],
  });
});
```

`mockName` makes a failure name the method. `mockReturnValue(of(...))` answers an observable, `mockResolvedValue` a promise. For time, `vi.useFakeTimers()` and `vi.advanceTimersByTimeAsync()` replace `fakeAsync`, with `vi.useRealTimers()` in a `finally`. HTTP is tested as before: `provideHttpClient()`, `provideHttpClientTesting()`, then `HttpTestingController` to expect and answer requests, and `verify()` after each test.

Specs that render translated text import a shared `provideTranslocoTesting()`. It loads the real catalogues and throws on a missing key, so a typo in a template fails a test instead of rendering as the key.


## What a green suite does not prove
jsdom does not lay anything out. `getBoundingClientRect()` returns zeros, nothing overflows and nothing scrolls. A spec can check that a button has a class. It cannot check that the button fits next to its field. The Starter once shipped a washed-out dark theme and pages that had stopped scrolling, with every spec green. That is what its [Playwright gallery](/blog/2026-08-14-visual-review-for-an-angular-app-with-playwright/) is for.

The stubs are a cost too. A `matchMedia` that never matches hides a bug that only shows on a phone.

Not everything needs a spec either. The Starter leaves thin API clients untested on purpose: they only forward to `HttpClient`, so a test would restate them. And a large Karma suite full of `fakeAsync` on zone.js has no reason to move today. The move pays off when going zoneless, since `fakeAsync` leaves with zone.js.


## References
- [Testing](https://angular.dev/guide/testing) — Angular: the testing guide, Vitest and the unit-test builder included.
- [Zoneless](https://angular.dev/guide/zoneless) — Angular: change detection without zone.js, and its effect on tests.
- [Mocking](https://vitest.dev/guide/mocking) — Vitest: `vi.fn`, `vi.spyOn` and fake timers.
- [jsdom](https://github.com/jsdom/jsdom) — the DOM the specs run against, and what it does not implement.
