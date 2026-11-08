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

For years, `ng test` meant Karma launching a real Chrome and Jasmine running the specs inside it. Karma is deprecated, the browser makes the suite slow to start, and an application without zone.js has no use for `fakeAsync` anymore. The Angular CLI now ships a builder that runs the same specs on [Vitest](https://vitest.dev/) instead, in Node, against a DOM emulated by [jsdom](https://github.com/jsdom/jsdom).

In this article, we will configure that builder, write specs for a zoneless application with `TestBed`, test signals and components with signal inputs, mock with `vi.fn`, and look at what jsdom cannot tell us. The examples come from [Blouppy Starter](https://starter.blouppy.com/), an Angular 22 application whose suite moved from Karma to Vitest, and from its design-system harness, where the shared component library keeps its own specs.


## The builder
The test target of `angular.json` names the `@angular/build:unit-test` builder and Vitest as its runner. This is the application's target, as it is:

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

The builder compiles the specs with the application's own build pipeline and bootstraps `TestBed` for us: there is no `test.ts` and no `karma.conf.js` left. The specs run in jsdom, which the application installs as a dev dependency next to `vitest` and `@vitest/coverage-v8`. `setupFiles` runs before every spec file, and `runnerConfig` points at a regular Vitest configuration file for what the builder's options cannot express.

`tsconfig.spec.json` adds Vitest's globals, so that `describe`, `it`, `expect` and `vi` need no import:

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "outDir": "./out-tsc/spec",
    "types": ["vitest/globals"]
  },
  "include": ["src/**/*.spec.ts", "src/**/*.d.ts", "src/testing/transloco-testing.ts"]
}
```

The scripts stay short: `ng test` watches, and CI runs `ng test --watch=false --coverage`.


## The Vitest configuration file
In the Starter, `vitest.config.ts` holds two things. The first is coverage thresholds that fail the build, a modest floor for the whole application and stricter bars for the core services:

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    coverage: {
      reportsDirectory: './coverage',
      reporter: ['html', 'lcovonly', 'text-summary'],
      thresholds: {
        statements: 40,
        branches: 30,
        functions: 45,
        lines: 40,
        '**/app/core/**/services/*.service.ts': { statements: 75, branches: 60, functions: 70, lines: 75 },
      },
    },
  },
});
```

The second is a workaround. Vitest externalises `node_modules`, and a CommonJS package loaded that way can hand its consumer a module namespace instead of a callable default export. The rich-text editor depends on `tippy.js`, and every spec rendering it threw "tippy is not a function" until both were inlined, so that Vite transforms them:

```ts
server: {
  deps: {
    inline: [/tippy\.js/, /@tiptap\//],
  },
},
```

Karma never needed this, because it ran the bundle in a browser. Expect a few of these lines when migrating a suite with older dependencies.


## What jsdom lacks
jsdom implements the DOM and little of the browser around it. The Starter's `setup-jsdom.ts` fills the gaps the application actually hits. `window.matchMedia`, which the theme service calls at construction time, does not exist, so it is stubbed to report "does not match" and never fire:

```ts
if (typeof window !== 'undefined' && typeof window.matchMedia !== 'function') {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    configurable: true,
    value: (query: string): MediaQueryList =>
      ({
        matches: false,
        media: query,
        onchange: null,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
        dispatchEvent: () => false,
      }) as unknown as MediaQueryList,
  });
}
```

A spec that needs a given media state overrides `matchMedia` itself. jsdom has no canvas either: `getContext` writes "Not implemented" to the console and returns `null`, so the file replaces it with a silent `() => null`, which the chart component already reads as "nothing to draw on".

The same file also clears storage before each spec file:

```ts
beforeAll(() => {
  localStorage.clear();
  sessionStorage.clear();
});
```

This one came from a flaky suite. jsdom's Web Storage is shared by every spec file of a worker, so a `language` of `fr` left behind by one file started the next file's language service in French, and a spec formatting a number failed, in some orders only. Each file now starts on empty storage, and a spec that needs a value sets it itself.


## A zoneless TestBed
The application provides `provideZonelessChangeDetection()` and loads no zone.js, and its specs do not configure change detection at all: since Angular 21, zoneless is the default, `TestBed` included. Without zone.js, `fakeAsync`, `tick` and `waitForAsync` are gone, because they are built on zone.js. What replaces them is plain `async`/`await`:

- `fixture.detectChanges()` still renders synchronously.
- `await fixture.whenStable()` waits until Angular has nothing pending, such as a render scheduled by a signal or an HTTP request still in flight in the component.
- `TestBed.tick()` runs the effects and change detection now, for a service with no fixture.
- Vitest's fake timers stand in for `tick(ms)`.

The minimal component spec, for a component with a signal input:

```ts
@Component({
  selector: 'app-greeting',
  template: `<h1>Hello {{ name() }}</h1>`,
})
class GreetingComponent {
  public readonly name = input.required<string>();
}

it('should greet by name', () => {
  const fixture = TestBed.createComponent(GreetingComponent);

  fixture.componentRef.setInput('name', 'Ada');
  fixture.detectChanges();

  expect(fixture.nativeElement.querySelector('h1').textContent).toContain('Ada');
});
```

A signal input is read-only from the outside: `fixture.componentInstance.name` is an `InputSignal` with no `set`. `fixture.componentRef.setInput()` goes through the same path as a parent template binding, so it works for `input()`, `input.required()` and a classic `@Input()` alike.

The Starter's page header spec is this shape with the real catalogues of translations:

```ts
beforeEach(async () => {
  // Arrange (shared)
  await TestBed.configureTestingModule({
    imports: [provideTranslocoTesting(), PageHeaderComponent],
    providers: [provideRouter([])],
  }).compileComponents();

  fixture = TestBed.createComponent(PageHeaderComponent);
  sut = fixture.componentInstance;
  fixture.componentRef.setInput('title', 'Workspace Settings');
});

it('should render the back link with an accessible label when set', () => {
  // Arrange
  fixture.componentRef.setInput('backLink', ['/acme-corp', 'workspaces', 1]);
  fixture.componentRef.setInput('backLabel', 'Back to workspace');

  // Act
  fixture.detectChanges();

  // Assert
  const link = fixture.nativeElement.querySelector('a');
  expect(link.getAttribute('aria-label')).toBe('Back to workspace');
});
```

When a component loads data in reaction to its inputs, `detectChanges()` is not enough: the AI usage panel of the billing page reads its data once the organization input and the reader's role are known. Its spec sets the input, renders, then awaits:

```ts
fixture = TestBed.createComponent(AiUsageComponent);
fixture.componentRef.setInput('organization', organization());
fixture.detectChanges();
await fixture.whenStable();
```

To test "it asks once the user turns out to be an administrator", the spec owns the `canManage` signal of the fake permissions service, sets it to `true`, then calls `detectChanges()` and `whenStable()` again before asserting that the API was called.


## Signals in a service
A service whose state is signals is tested by reading them. `WorkspaceService` turns the current organization, a signal of another service, into an observable with `toObservable`, and reloads its list when it changes. `toObservable` is built on an effect, and an effect only runs when Angular flushes it, so the spec calls `TestBed.tick()` after creating the service and after each change:

```ts
it('should reload the list when the reader switches organization', () => {
  // Arrange
  const sut = createService(anOrganization(10), [aWorkspace({ id: 1 })]);
  workspacesApi.get.mockReturnValue(of([aWorkspace({ id: 7, organizationId: 20 })]));

  // Act
  currentOrganization.set(anOrganization(20));
  TestBed.tick();

  // Assert
  expect(workspacesApi.get).toHaveBeenLastCalledWith({ organizationId: 20 });
  expect(sut.workspaces().map(workspace => workspace.id)).toEqual([7]);
});
```

Here `currentOrganization` is a real `signal()` the spec created and handed to the fake `OrganizationService`. Faking a dependency with a real signal is simpler than mocking a getter, and the service under test reacts to it exactly as in the application. Without the `TestBed.tick()`, the assertion runs before the effect and the test fails on the old list.


## Mocks with vi.fn
Jasmine's `createSpyObj` has no direct equivalent, and the Starter does not need one: a mock is an object literal of `vi.fn()`, typed with `MockedObject<Pick<…>>` so that it can only fake members that exist. From the clipboard service spec of the component library:

```ts
import type { MockedObject } from 'vitest';

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

`mockName` makes a failure name the method instead of `spy`. `mockReturnValue(of(...))` answers an observable, `mockResolvedValue` a promise, and `vi.spyOn(window, 'open')` replaces a browser API for one test.

Fake timers replace `fakeAsync`. The SSO connection screen polls a pop-up every second until it closes; its spec fakes the timers, advances them, and always restores them:

```ts
vi.useFakeTimers();

try {
  await createComponent();
  const popup = { closed: false };
  vi.spyOn(window, 'open').mockReturnValue(popup as Window);

  // Act
  sut.test();
  popup.closed = true;
  await vi.advanceTimersByTimeAsync(1000);

  // Assert
  expect(sut.isTesting()).toBe(false);
} finally {
  vi.useRealTimers();
}
```

When only the clock matters, `vi.useFakeTimers({ toFake: ['Date'] })` with `vi.setSystemTime(NOW)` fixes "now" and leaves `setTimeout` real, which is what the personal access token dialog does to compute an expiry date.


## HttpTestingController
HTTP is tested the way it was under Karma: `provideHttpClient()` followed by `provideHttpClientTesting()`, then `HttpTestingController` to expect and answer requests, and `verify()` after each test so that an unexpected request fails it:

```ts
beforeEach(() => {
  TestBed.configureTestingModule({
    providers: [provideHttpClient(), provideHttpClientTesting()],
  });

  service = TestBed.inject(TeamsApiService);
  httpTesting = TestBed.inject(HttpTestingController);
});

afterEach(() => {
  httpTesting.verify();
});

it('should put the directory group a team is linked to', () => {
  // Act
  service.linkDirectoryGroup(3, 9, 'group-1').subscribe();

  // Assert
  const req = httpTesting.expectOne('/api/v1/workspaces/3/teams/9/directory-group');

  expect(req.request.method).toBe('PUT');
  expect(req.request.body).toEqual({ groupId: 'group-1' });
  req.flush(null);
});
```

For an interceptor, `provideHttpClient(withInterceptors([errorInterceptor]))` wires it in, and `flush('boom', { status: 500, statusText: 'Server Error' })` answers with an error. The error interceptor's spec turns the subscription into a promise and uses `await expect(failed).resolves.toBe(500)` before checking that the toast was shown.


## The Starter's helpers
`src/testing/` holds what several specs share. The most used is `provideTranslocoTesting()`, which every spec rendering a translated template imports. It loads the real `en.json` and `fr.json` and replaces Transloco's missing-key handler with one that throws:

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

By default, Transloco renders a missing key as the key itself, and a spec checking the surrounding text would never notice. With this handler, a key missing from `en.json` fails a test. It also lets a spec call `setActiveLang('fr')` and assert that the page follows the switch without a reload, which the AI usage spec does. The helper has its own spec, so that it keeps throwing.

The folder also holds `ScriptedAssistantStream`, a fake server-sent stream a spec pushes events into, with `flushStream()` to let a `for await` catch up.


## What a green suite does not prove
Everything above runs in jsdom, and jsdom does not lay anything out: no CSS is applied to the geometry, `getBoundingClientRect()` returns zeros, nothing overflows and nothing scrolls. A unit spec can check that a class is present on a button, the way the copy button spec checks that it inherits `uiButton`'s small size. It cannot check that the button fits next to its field. The Starter shipped a washed-out dark theme and pages that had stopped scrolling inside the shell with every spec green. That is what its [Playwright gallery](/blog/2026-08-14-visual-review-for-an-angular-app-with-playwright/) is for.

There are other costs. The stubs of `setup-jsdom.ts` are our code, and a stub that answers "does not match" everywhere hides a bug that only shows on a phone. The CommonJS inlining has to be found by a failing spec. And Vitest's mocks differ from Jasmine's in small ways, such as `mockResolvedValue` in place of `and.resolveTo`, so migrating a large Jasmine suite takes real work.


## When not to bother
Not everything needs a spec. The Starter's coverage configuration says so: thin API clients that only forward to `HttpClient` are intentionally not unit-tested as a rule, because a test would restate the implementation. A client earns a spec when it builds something, a URL from several ids or query parameters.

If an application still runs zone.js and a large Karma suite full of `fakeAsync`, nothing forces a move today. The gain is speed, no browser to install in CI and a single test runner for the front end; it is worth it when you touch the suite anyway, or when you go zoneless, since `fakeAsync` goes away with zone.js.


## Conclusion
The unit-test builder keeps `ng test` and `TestBed` and swaps what is under them: Vitest instead of Karma and Jasmine, jsdom instead of Chrome. In a zoneless application, specs become plain `async` functions: `setInput` for signal inputs, `whenStable()` and `TestBed.tick()` instead of `fakeAsync`, `vi.fn` objects typed with `Pick` for mocks, fake timers for time. Keep a setup file for what jsdom lacks, make missing translations fail, and remember that a green suite says nothing about layout.


## References
- [Angular: testing](https://angular.dev/guide/testing) — the official testing guide, Vitest and the unit-test builder included.
- [Angular: zoneless](https://angular.dev/guide/zoneless) — change detection without zone.js, and its effect on tests.
- [Angular: testing services with HTTP](https://angular.dev/guide/http/testing) — `provideHttpClientTesting` and `HttpTestingController`.
- [Vitest: mocking](https://vitest.dev/guide/mocking) — `vi.fn`, `vi.spyOn` and fake timers.
- [Vitest: server.deps.inline](https://vitest.dev/config/#server-deps-inline) — the option used for the CommonJS packages.
- [jsdom](https://github.com/jsdom/jsdom) — the DOM implementation the specs run against, and what it does not implement.
- [Transloco: unit testing](https://jsverse.gitbook.io/transloco/advanced-features/unit-testing) — `TranslocoTestingModule`.
