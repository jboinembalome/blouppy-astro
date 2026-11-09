---
templateKey: 'blog-post'
title: 'Type or interface in TypeScript: what an Angular code base actually needs'
date: 2026-07-30T09:00:00.000Z
author: Jimmy Boinembalome
authorimage: /img/jimmy.jpg
category: Angular
topic: 'Front end'
illustration: 1
categorycolor: bg-red-100 text-red-800
featuredpost: true
description: >-
  Learn when to write type or interface in an Angular code base: declaration merging, extends versus intersections, unions and mapped types, implements, and the lint rule that decides.
tags:
  - Development
  - TypeScript
  - Angular
  - ESLint
---

Every TypeScript code base ends up with both. A model is an `interface` in one file and a `type` in the next, and a review asks "why not an interface here?". Usually the answer is "it does not matter", and it is right. A few times it is not.

For a plain object shape, the two are interchangeable. TypeScript is structurally typed, so a value that fits `interface Workspace { id: number }` also fits `type Workspace = { id: number }`, and `HttpClient.get<Workspace>()` does not care which keyword we used. The differences are at the edges.


## Interfaces merge
Two `interface` declarations with the same name in the same scope merge into one. Two `type` declarations with the same name are an error:

```ts
interface Workspace { id: number }
interface Workspace { colour: string }   // merged: { id: number; colour: string }

type Team = { id: number };
type Team = { name: string };            // error TS2300: Duplicate identifier 'Team'.
```

Merging is how we extend a type we do not own. The design-system library of [Blouppy Starter](https://starter.blouppy.com/) wraps the tiptap editor with the `tiptap-markdown` extension. tiptap types `editor.storage` as an interface that each extension declares itself into, but `tiptap-markdown` never declares its entry. A module augmentation fills the gap:

```ts
declare module '@tiptap/core' {
  interface Storage {
    markdown: MarkdownStorage;
  }
}
```

This only works because tiptap wrote `Storage` as an interface. With a `type`, there would be nothing to merge into.

Merging can also happen by accident. In a script file, one with no `import` or `export`, a top-level `interface Notification` is global and merges with the DOM's own `Notification`. The compiler then asks for `body`, `icon` and fifteen other properties. Angular files almost always import something, so this mostly bites in a `.d.ts` or a quick script.


## `extends` fails early, `&` fails late
An interface builds on another with `extends`. A type alias combines with `&`. They look equivalent until the two sides disagree:

```ts
interface Base { id: number }

interface Wrong extends Base { id: string }
// error TS2430: Interface 'Wrong' incorrectly extends interface 'Base'.

type Inter = Base & { id: string };
const value: Inter = { id: 'x' };
// error TS2322: Type 'string' is not assignable to type 'never'.
```

`extends` reports the conflict where it is declared, and the message names both sides. The intersection is accepted as written. `id` becomes `string & number`, which is `never`, and the error shows up wherever someone builds a value, without saying why.

There is a compiler cost too. The TypeScript performance guide recommends interfaces over intersections: the checker caches an interface's relationships, while it recombines an intersection each time. On a few models this is invisible. On large generic intersections, it is one of the first things to change.

An interface can also extend a type alias or a class, as long as its members are known statically. `@blouppy/ui` does this to add header options to the CDK's `DialogConfig` class, and call sites keep passing an object literal.


## What only `type` can express
An interface always describes an object. Everything else needs a type alias: unions, mapped and conditional types, tuples, aliases of primitives and functions, and types derived from values such as `(typeof NOTIFICATION_TYPES)[number]`.

The discriminated union is the one we meet most. Here is a payment result told apart by its `status`:

```ts
type PaymentResult =
  | { status: 'paid'; receiptUrl: string }
  | { status: 'declined'; reason: string }
  | { status: 'pending' };

function describe(result: PaymentResult): string {
  switch (result.status) {
    case 'paid': return `Receipt: ${result.receiptUrl}`;
    case 'declined': return `Declined: ${result.reason}`;
    case 'pending': return 'Waiting for the bank';
  }
}
```

Each branch is narrowed to its own properties. The Starter's AI assistant streams its answer the same way: each server-sent event is one of six shapes, so `AssistantStreamEvent` is a `type`.

A class can `implements` an interface or an object type alias, but not a union: there is no single set of members to check. In practice nearly every `implements` in Angular targets a framework interface (`ControlValueAccessor`, `PipeTransform`), so our own keyword plays no part.

One more difference bites now and then. A type alias of an object literal gets an implicit index signature, an interface does not. So a value typed with an interface is not assignable to `Record<string, unknown>`. Interfaces stay open to merging, so TypeScript cannot promise that no other key will appear.


## What the Starter uses, and why
The pattern in the Starter is plain. API models in `core/models` are interfaces: `Workspace`, `Notification`, `CursorPage<T>`, built on each other with `extends`. The type aliases in that folder are all things an interface cannot be: string unions mirroring the API's enums (`OrganizationRole`, `Colour`), types derived from `as const` arrays, and the stream union. `@blouppy/ui` has more aliases than interfaces, because its component inputs are mostly closed sets such as `type ButtonVariant = 'solid' | 'outlined' | 'text'`.

No configuration in the Starter mentions a rule for this. The pattern comes from a preset: every front-end app and the library extend `tseslint.configs.stylistic`, as in [Configure ESLint with Angular](/blog/2023-04-03-configure-eslint-with-angular/). That preset turns on `@typescript-eslint/consistent-type-definitions` with its default, `'interface'`. The rule only reports an alias whose whole right-hand side is an object literal, and `--fix` rewrites it. Unions, mapped types and intersections are left alone.

A team that prefers aliases sets the rule to `['error', 'type']`. The fixer then turns `extends` into intersections, and the early conflict check is lost.


## A rule of thumb
For a model used by a service and a few components, the choice changes nothing at runtime: both keywords are erased. What a rule buys is the end of the review conversation. So:

- An object shape (an API model, a component's options, a config) is an `interface`, built with `extends`.
- Anything else (a union, a set of options, a mapped or derived type) is a `type`.
- Use `&` only when the parts cannot overlap.

Turn on the `stylistic` preset and let the fixer apply the first point. It starts to matter in only three places: a library type meant to be augmented, a hierarchy where a conflict should fail loudly, and very large compositions where the checker's speed shows.


## References
- [Differences between type aliases and interfaces](https://www.typescriptlang.org/docs/handbook/2/everyday-types.html#differences-between-type-aliases-and-interfaces) — TypeScript handbook: the official comparison.
- [Declaration merging](https://www.typescriptlang.org/docs/handbook/declaration-merging.html) — TypeScript handbook: interface merging and module augmentation.
- [Preferring interfaces over intersections](https://github.com/microsoft/TypeScript/wiki/Performance#preferring-interfaces-over-intersections) — TypeScript wiki: the compiler performance advice.
- [consistent-type-definitions](https://typescript-eslint.io/rules/consistent-type-definitions/) — typescript-eslint: the rule, its options and its fixer.
