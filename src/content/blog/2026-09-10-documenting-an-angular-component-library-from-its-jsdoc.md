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

A component library gets a documentation page, and the page gets an API table: name, type, default, description. Then someone adds an input, renames a union member, or changes a default from `'md'` to `'sm'`. The table keeps the old answer. A drifted API table is worse than none, because readers trust it.

The fix is to generate the table from the library itself, and to fail the build on a member nobody documented.


## Why the compiler API, not a regex
Signal inputs are class fields set by a function call, which looks easy to grep:

```ts
export class TagComponent {
  /** What the state means. */
  public readonly severity = input<Severity>('primary');
  /** A pill rather than a rounded rectangle. */
  public readonly rounded = input(false);
}
```

The first field names its type. The second does not: `input(false)` has no type argument, and its `boolean` exists only after inference, in the type checker. A regex sees `false`. A bare parse sees a call with one argument. To get `boolean`, we need a real `ts.Program` and its `TypeChecker`.

Here is a minimal script for one file:

```js
import ts from 'typescript';

const path = 'src/tag/tag.component.ts';
const program = ts.createProgram({ rootNames: [path], options: { strict: true, skipLibCheck: true } });
const checker = program.getTypeChecker();

for (const node of program.getSourceFile(path).statements.filter(ts.isClassDeclaration)) {
  for (const member of node.members) {
    if (!ts.isPropertyDeclaration(member) || !member.initializer || !ts.isCallExpression(member.initializer)) {
      continue;
    }

    // InputSignal<boolean>: the first type argument is what a caller binds.
    const [carried] = checker.getTypeArguments(checker.getTypeAtLocation(member.name));
    const symbol = checker.getSymbolAtLocation(member.name);
    const description = ts.displayPartsToString(symbol.getDocumentationComment(checker));

    console.log(member.name.getText(), checker.typeToString(carried), description);
  }
}
```

`getTypeAtLocation` returns `InputSignal<boolean>`, and `getTypeArguments` unwraps it. The same works for `ModelSignal<T>` and `OutputEmitterRef<T>`. `getDocumentationComment` returns the JSDoc the editor shows on hover. That is the point: one description, read at the call site and on the documentation page.

One condition: the program must resolve the library's imports, `@angular/core` included. Otherwise the checker answers `any`, without an error.


## The playground of @blouppy/ui
[Blouppy Starter](https://starter.blouppy.com/) ships its design system as a library, `@blouppy/ui`, used as source by four Angular apps. Its documentation is a fifth app, the **playground**: one page per primitive, with runnable examples and an API reference. It is never deployed, and it is not optional.

Every page is an entry in `catalogue.ts`, with a `sources` list naming the library folders it documents. A page is a subject, not a folder: `form-controls` covers five folders. The sidenav, the router and the extractor, `tools/build-api.mjs`, all read that list.

The extractor is the script above, grown up. It builds one program over the whole library, finds `input()`, `model()`, `output()` and their `.required` forms, and records the default as written. It prefers the written type argument to the checker's, so `input<Severity>()` reads as `Severity` rather than seven string literals; the literals are listed below it. The result is a generated `api.ts` that each page renders at its bottom.

Then come the throws. A `sources` entry that is not a real folder would silently drop a page's API section, so it fails. And a member with no JSDoc fails too:

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

The error names every offender and says where the fix goes: in the library, never in a copy inside the harness. The script runs before `build`, `dev` and `test`, so a missing comment stops all three, and CI builds the playground on every library change. It is the same idea as [architecture tests that fail the build](/blog/2026-07-03-architecture-tests-that-fail-the-build/): a rule enforced by review holds on good days only.

The check only covers what a page claims, so a new folder no page names would escape it. Hence the project rule: **a primitive is not done until it has an entry in `catalogue.ts`**. The script prints the folders no page claims, as a reminder rather than a failure, since a few folders (`brand`, `i18n`, `url`) are infrastructure. The examples follow the same principle: their code is pulled from the showcase source at build time, so it cannot drift either.


## Storybook and Compodoc
[Storybook](https://storybook.js.org/docs/get-started/frameworks/angular) is the obvious alternative, and for many teams the better one. It turns each input into a live control, which the playground does not have. It brings accessibility checks, interaction tests and visual testing off the shelf, maintained by someone else. And newcomers often already know it. For Angular, its argument tables come from [Compodoc](https://compodoc.app/), so the docs still come from the code. Compodoc also has a coverage report that can fail the run below a threshold.

The home-made generator gives something small but specific in exchange. Pages render with the library's own primitives, in the apps' real theme. And the failing rule is exactly ours: *every* member, not a percentage.

It has limits. It matches syntax, so an aliased `import { input as signalInput }` or a decorator `@Input()` is invisible to it. Type-checking the whole library adds a few seconds to each run. And the check proves that a comment exists, not that it says anything: `/** The severity. */` passes.

For a library with a handful of components and one consumer, a README and the editor's hover are enough. The generator pays off when several apps share the library and we want the build, not a reviewer, to say a member is undocumented.


## References
- [Using the Compiler API](https://github.com/microsoft/TypeScript/wiki/Using-the-Compiler-API) — TypeScript wiki: `createProgram`, the type checker and the syntax tree.
- [Accepting data with input properties](https://angular.dev/guide/components/inputs) — Angular: `input()`, `model()` and inferred input types.
- [Storybook for Angular](https://storybook.js.org/docs/get-started/frameworks/angular) — Storybook: setup, and how it uses Compodoc for argument types.
- [Compodoc](https://compodoc.app/) — documentation generator for Angular, with a coverage report.
