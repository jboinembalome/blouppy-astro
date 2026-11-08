---
templateKey: 'blog-post'
title: 'Documenting an Angular component library from its own JSDoc'
date: 2026-09-10T09:00:00.000Z
author: Jimmy Boinembalome
authorimage: /img/jimmy.jpg
category: Angular
topic: 'Tooling'
illustration: 2
categorycolor: bg-red-100 text-red-800
featuredpost: true
description: >-
  Learn how to generate the API reference of an Angular component library from its signal inputs and JSDoc with the TypeScript compiler API, and fail the build on a member nobody documented.
tags:
  - Development
  - Angular
  - TypeScript
---

A component library gets a documentation page, and the page gets an API table: name, type, default, description. Then someone adds an input, renames a union member, or changes a default from `'md'` to `'sm'`, and the table keeps the old answer. A drifted API table is worse than none, because it is read as authoritative.

In this article, we will generate that table from the library itself. A small Node.js script reads every `input()`, `model()` and `output()` of an Angular library with the **TypeScript compiler API**, takes each description from the member's own JSDoc, writes the API reference of every documentation page, and **fails the build** on a member with no JSDoc. We will then compare the approach honestly with Storybook and Compodoc, and say when it is not worth it.


## Why the compiler API, and not a regex
Signal inputs are plain class fields initialised by a function call, which looks easy to grep:

```ts
export class TagComponent {
  /** What the state means. Map it from the domain once, per the note on `Severity`. */
  public readonly severity = input<Severity>('primary');
  /** A pill rather than a rounded rectangle. */
  public readonly rounded = input(false);
}
```

The first line names its type. The second does not: `input(false)` has no type argument, and its `boolean` exists only after inference, in the type checker. A regex sees `false`; a bare parse (`ts.createSourceFile`) sees a call with one argument. To get `boolean`, we need a real `ts.Program` and its `TypeChecker`.

Here is the minimal version, for one file:

```js
import ts from 'typescript';

const program = ts.createProgram({
  rootNames: ['src/tag/tag.component.ts'],
  options: { strict: true, skipLibCheck: true, experimentalDecorators: true },
});
const checker = program.getTypeChecker();
const file = program.getSourceFile('src/tag/tag.component.ts');

for (const node of file.statements.filter(ts.isClassDeclaration)) {
  for (const member of node.members) {
    if (!ts.isPropertyDeclaration(member) || !member.initializer || !ts.isCallExpression(member.initializer)) {
      continue;
    }

    // InputSignal<boolean>: the first type argument is what a caller binds.
    const signal = checker.getTypeAtLocation(member.name);
    const [carried] = checker.getTypeArguments(signal);
    const description = ts.displayPartsToString(checker.getSymbolAtLocation(member.name).getDocumentationComment(checker));

    console.log(member.name.getText(), checker.typeToString(carried), description);
  }
}
```

- `getTypeAtLocation` returns the field's type, `InputSignal<boolean>`, and `getTypeArguments` unwraps it. The same holds for `ModelSignal<T>` and `OutputEmitterRef<T>`.
- `getDocumentationComment` returns the JSDoc the editor shows on hover. That is the point of the whole exercise: one description, read both at the call site and on the documentation page.
- The program must resolve the library's imports, `@angular/core` included, or the checker answers `any`.


## The real example: a playground for @blouppy/ui
[Blouppy Starter](https://starter.blouppy.com/) ships its design system as a library, `@blouppy/ui`, consumed as source by four Angular applications. Its documentation is a fifth application, the **playground**: one page per primitive, in both colour schemes, with runnable examples and an API reference. It is never deployed, and it is not optional.

### One list, read four times
Every page is one entry in `catalogue.ts`:

```ts
export const CATALOGUE: readonly CatalogueEntry[] = [
  {
    id: 'tag',
    name: 'Tag',
    group: 'Status',
    summary: 'A tinted label for a state.',
    sources: ['tag'],
    load: () => import('./showcase/tag.showcase').then(m => m.TagShowcaseComponent),
  },
  // ...
];
```

The sidenav, the search dialog and the router read this list, and so does the API extractor, `tools/build-api.mjs`. `sources` names the folders under `front/libs/ui/src` that the page documents. It is not derived from `id`, because a page is a subject rather than a folder: `form-controls` covers five folders, and `clipboard` covers a component and the service behind it.

The script cannot `import` the catalogue, since it is TypeScript and each entry carries a lazy `load` arrow. It reads it from its syntax tree instead, and refuses an entry with no `sources`, which would otherwise render an empty API section without any other symptom.

### Finding the signal members
The script builds one program over every non-spec `.ts` file of the library, with compiler options that mirror the playground's own, `paths` included, because the library has no `tsconfig` of its own. Then, for each exported class decorated with `@Component` or `@Directive`, it looks at every property initialiser:

```js
const MEMBER_KINDS = { input: 'input', model: 'model', output: 'output' };

function signalFactory(initializer) {
  if (!initializer || !ts.isCallExpression(initializer)) {
    return undefined;
  }

  const callee = initializer.expression;

  if (ts.isIdentifier(callee) && MEMBER_KINDS[callee.text]) {
    return { kind: MEMBER_KINDS[callee.text], required: false };
  }

  // input.required<T>() / model.required<T>()
  if (
    ts.isPropertyAccessExpression(callee) &&
    ts.isIdentifier(callee.expression) &&
    MEMBER_KINDS[callee.expression.text] &&
    callee.name.text === 'required'
  ) {
    return { kind: MEMBER_KINDS[callee.expression.text], required: true };
  }

  return undefined;
}
```

The type comes next, with one deliberate preference: **the written type argument wins over the checker's**.

```js
function memberType(checker, property, call) {
  if (call.typeArguments?.length) {
    return call.typeArguments[0].getText();
  }

  const type = checker.getTypeAtLocation(property.name);
  const args = typeArgumentsOf(checker, type);

  return args.length ? checker.typeToString(args[0], undefined, TYPE_FORMAT) : 'unknown';
}
```

`input<Severity>()` should read as `Severity`, not as the seven string literals the checker would expand it to. The literals are still collected separately, from the resolved type, and shown under the type as the values a caller can pass. And because a member of `ui-tag` names `Severity`, which is declared in another folder, the script pulls that alias onto the tag page too: it is the question the table provokes.

Each member ends up as a row: name, kind, `required`, type, literal values, the default (the first argument of `input()` or `model()`, as written, and nothing for an `output()`), and the JSDoc. The script also lists the `<ng-content>` slots a component's template declares, since projection is half of how several primitives are used, and the public methods of each `@Injectable`. Everything is written to a generated `api.ts`, which the page's `pg-api-reference` component renders at the bottom of every showcase.

### The checks that fail the build
The generator is only half the value. The other half is what it refuses. A typo in `sources` would silently drop a page's API section, so it throws:

```js
for (const { id, sources } of catalogue) {
  for (const source of sources) {
    const entry = byFolder.get(source);

    if (!entry) {
      throw new Error(`catalogue.ts: entry "${id}" names source "${source}", which is not a folder under front/libs/ui/src`);
    }

    // ... gathers the folder's classes, services and types onto the page
  }
}
```

A page whose sources hold no component, directive or injectable throws too. And then the check this article is named after:

```js
const undocumented = Object.entries(api).flatMap(([id, page]) =>
  page.classes.flatMap(item => item.members.filter(member => !member.description).map(member => `${id}: ${item.name}.${member.name}`))
);

if (undocumented.length) {
  throw new Error(
    [`${undocumented.length} member(s) have no JSDoc — write one in front/libs/ui/src, where the editor will show it too:`, ...undocumented].join('\n  ')
  );
}
```

The error names every offender as `page: Class.member`, and says where the fix goes: in the library, never in a second copy inside the harness. The descriptions stay in English and out of the application's translation files, because they are API documentation.

The script runs on `prebuild`, `predev` and `pretest` (`npm run generate`, which also extracts the examples), so a missing comment stops `ng build`, `ng serve` and the specs alike. CI builds the playground on every change under `front/libs/`, because the library's own component specs run there. That is the same idea as [architecture tests that fail the build](/blog/2026-07-03-architecture-tests-that-fail-the-build/): a rule enforced by review is a rule enforced on good days.

### A primitive is not done until it is in the catalogue
The JSDoc check only covers what a catalogue page claims. A new folder that no page names would escape it entirely. So the project's rule is written down: **a primitive is not done until it has an entry in `catalogue.ts`**, with the folders it documents in `sources`. The script backs it up by printing the folders no page claims:

```js
const orphans = [...byFolder.keys()].filter(folder => !referenced.has(folder)).sort();

if (orphans.length) {
  console.log(`    (not documented by any catalogue page: ${orphans.join(', ')})`);
}
```

This one is informational, not a failure, because some folders are infrastructure that no page shows (`brand`, `i18n`, `url`). An allow-list of those three would turn it into a hard check; the Starter has not needed one yet.

### Examples come from the same source
The runnable examples follow the same principle. `tools/build-examples.mjs` pulls the markup of each `<pg-specimen>` out of the showcase source, highlights it at build time with Shiki, and fails on a specimen with no `label`. The code shown under an example is the code being rendered, so it cannot drift either. How those pages are then photographed in both schemes is the subject of [visual review with a Playwright gallery](/blog/2026-08-14-visual-review-for-an-angular-app-with-playwright/), and we will not repeat it here.


## Storybook and Compodoc
[Storybook](https://storybook.js.org/docs/get-started/frameworks/angular) is the obvious alternative, and for many teams the better one:

- **Controls.** Storybook turns each input into a live control, so a reader changes `severity` and sees the result. The playground has fixed specimens and no controls.
- **Addons and ecosystem.** Accessibility checks, interaction tests, viewport switching, hosted visual testing: Storybook has them off the shelf, maintained by someone else. Every feature of a home-made harness is code we own.
- **Familiarity.** A designer or a new developer often already knows Storybook. Nobody knows our playground.
- **For Angular, the argument tables come from Compodoc.** Storybook's Angular integration reads [Compodoc](https://compodoc.app/)'s JSON output to infer its `argTypes`, so the documentation still comes from the code. Storybook also brings its own builder configuration and a second way of bootstrapping components, which has to track every Angular upgrade.

Compodoc on its own generates a full documentation site for an Angular project, modules, routes and dependency graphs included. It has a **documentation coverage** report, and `--coverageTest` fails the run below a threshold, which is close to our JSDoc check. Before adopting it for a library written with signal functions, we should check that the version we use reads `input()`, `model()` and `output()` the way we expect.

What the home-made generator gives in exchange is small but specific: the pages render with the library's own primitives, in the applications' real theme; `sources` maps a page to a subject rather than a file; the alias wins over its expansion; and the failing rule is exactly ours, *every* member, not a percentage.


## What it costs, and the pitfalls
- **It matches syntax.** `signalFactory` recognises the identifiers `input`, `model` and `output`. An aliased import (`import { input as signalInput }`) or a helper that wraps `input()` is invisible to it, and so is a decorator-based `@Input()`. The library has to be written the way the script reads it.
- **A program over the whole library.** Type-checking every file costs a few seconds on each `build`, `dev` and `test`, which is fine for a library of this size.
- **Mirrored compiler options.** The program's options copy the harness's `tsconfig`. If the two drift, a path stops resolving and a type degrades to `any` or `unknown` without an error.
- **Presence is not quality.** The check proves a comment exists, not that it says anything. `/** The severity. */` passes. Review still has to read the descriptions.
- **One more application.** The playground has lint, format, specs and a build in CI. That is the price of documentation that cannot lie.


## When not to bother
If the library has a handful of components and one consumer, a README with a short example per component is enough, and the editor's hover already shows the JSDoc. If the team wants live controls, addon-based testing, or a published component catalogue for designers, Storybook with Compodoc is the better trade, and a coverage threshold gets most of the way to the failing check. The generator described here pays off when the library is shared by several applications, its documentation should look exactly like them, and we want the build, not a reviewer, to say that a member is undocumented.


## Conclusion
An API table typed by hand is a table that drifts. Reading the library with a `ts.Program` gives the types that only the checker knows, such as the `boolean` behind `input(false)`, and the JSDoc the editor already shows. Two throws make it a rule: a `sources` entry that is not a folder, and a member with no description, each fail the build. The catalogue rule closes the gap the checks cannot see: a primitive with no page is not done.

This is how the playground of [Blouppy Starter](https://starter.blouppy.com/) documents `@blouppy/ui`; the [design system page](https://docs.starter.blouppy.com/choices/design-system/) explains why the library exists.


## References
- [Using the Compiler API (TypeScript wiki)](https://github.com/microsoft/TypeScript/wiki/Using-the-Compiler-API) — `createProgram`, the type checker and walking the syntax tree.
- [Accepting data with input properties (Angular)](https://angular.dev/guide/components/inputs) — `input()`, `input.required()` and inferred input types.
- [Two-way binding with model inputs (Angular)](https://angular.dev/guide/components/inputs#model-inputs) — `model()`.
- [Custom events with outputs (Angular)](https://angular.dev/guide/components/outputs) — `output()` and `OutputEmitterRef`.
- [JSDoc reference (TypeScript)](https://www.typescriptlang.org/docs/handbook/jsdoc-supported-types.html) — the JSDoc tags TypeScript understands.
- [Storybook for Angular](https://storybook.js.org/docs/get-started/frameworks/angular) — setup, and how it uses Compodoc for argument types.
- [Controls (Storybook)](https://storybook.js.org/docs/essentials/controls) — the live controls generated from a component's inputs.
- [Compodoc](https://compodoc.app/) — documentation generator for Angular, with a documentation coverage report.
- [Shiki](https://shiki.style/) — the highlighter the examples are rendered with at build time.
- [Blouppy Starter documentation: design system](https://docs.starter.blouppy.com/choices/design-system/) — why the Starter has its own component library.
