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

Every TypeScript code base ends up with both. A model is an `interface` in one file and a `type` in the next, a review asks "why not an interface here?", and the answer is usually "it does not matter". Most of the time that answer is right. A few times it is not: a property that silently becomes `never`, a library type that cannot be augmented, a class that cannot implement a union.

In this article, we will go through what really differs between `type` and `interface`: declaration merging, `extends` against intersections, what only `type` can express, and `implements`. Then we will look at what the front end of [Blouppy Starter](https://starter.blouppy.com/) uses for its API models and component inputs, the lint rule that decided it, and a rule of thumb.


## Two ways to name an object shape
For a plain object shape, the two are interchangeable:

```ts
interface Workspace {
  id: number;
  name: string;
}

type WorkspaceAlias = {
  id: number;
  name: string;
};
```

Both describe the same structure. TypeScript is structurally typed, so a value that fits one fits the other, and an `HttpClient.get<Workspace>()` call does not care which keyword we used. The differences are at the edges.


## Declaration merging
Two `interface` declarations with the same name in the same scope merge into one. Two `type` declarations with the same name are an error:

```ts
interface Workspace { id: number }
interface Workspace { colour: string }   // merged: { id: number; colour: string }

type Team = { id: number };
type Team = { name: string };            // error TS2300: Duplicate identifier 'Team'.
```

Merging is what lets us extend a type we do not own. The design-system library of the Starter, `@blouppy/ui`, wraps the tiptap editor with the `tiptap-markdown` extension. tiptap types `editor.storage` as an interface that each extension declares itself into, and `tiptap-markdown` never declares its entry. The library fills the gap with a module augmentation:

```ts
// libs/ui/src/rich-text-editor/markdown-storage.d.ts
import type { MarkdownStorage } from 'tiptap-markdown';

declare module '@tiptap/core' {
  interface Storage {
    markdown: MarkdownStorage;
  }
}
```

This only works because `Storage` is an interface. Had tiptap declared it with `type`, there would be nothing to merge into.

The other side of merging is that it can happen by accident. In a script file, one with no `import` or `export`, a top-level declaration is global, and it merges with the DOM's own types:

```ts
// no import, no export: this is a global declaration
interface Notification { isRead: boolean }

const n: Notification = { isRead: true };
// error TS2740: Type '{ isRead: true; }' is missing the following properties
// from type 'Notification': body, data, dir, icon, and 13 more.
```

The Starter has a `Notification` model, and it is an interface. It is safe because it lives in a module (`export interface Notification`), where declarations are scoped to the file. Angular files almost always import something, so this trap mostly bites in a `.d.ts` or a quick script.


## `extends` against intersections
An interface builds on another with `extends`; a type alias combines with `&`. They look equivalent until the two sides disagree:

```ts
interface Base { id: number }

interface Wrong extends Base { id: string }
// error TS2430: Interface 'Wrong' incorrectly extends interface 'Base'.
//   Types of property 'id' are incompatible.
//     Type 'string' is not assignable to type 'number'.

type Inter = Base & { id: string };
const value: Inter = { id: 'x' };
// error TS2322: Type 'string' is not assignable to type 'never'.
```

`extends` checks the conflict where it is declared, with a message that names both sides. The intersection is accepted as written: `id` becomes `string & number`, which is `never`, and the error shows up later, wherever someone tries to build a value, with a message that does not say why.

There is also a compiler cost. The TypeScript team's performance guide recommends interfaces over intersections: an interface is one flat object type whose relationships the checker caches, while an intersection is recombined every time it is checked. On a few models this is invisible. On large intersections built from generics, it is one of the first things the guide suggests changing.

An interface can extend more than another interface. It can extend any object type with statically known members, including a type alias or a class. `@blouppy/ui` uses that to add its header options to the CDK's dialog configuration, which is a class, while call sites keep passing an object literal:

```ts
import { DialogConfig } from '@angular/cdk/dialog';

export interface UiDialogConfig<D = unknown, R = unknown> extends DialogConfig<D, R> {
  header?: string;
  closeButton?: boolean;
  closeLabel?: string;
}
```


## What only `type` can express
An interface always describes an object. Everything else needs a type alias:

- **Unions**: `type PlanType = 'Free' | 'Pro' | 'Business'`.
- **Discriminated unions**: several object shapes told apart by one property.
- **Mapped and conditional types**: `[K in keyof T]`, `T extends U ? X : Y`.
- **Tuples and aliases of primitives or functions**: `type UiDateRange = readonly [Date | null, Date | null]`.
- **Types derived from values**: `(typeof NOTIFICATION_TYPES)[number]`.

The Starter's assistant streams its answer as server-sent events, and each frame is one of six shapes (four shown here). That is a discriminated union, so it is a `type`:

```ts
export type AssistantStreamEvent =
  | { type: 'conversation'; id: string; title: string }
  | { type: 'text'; delta: string }
  // … 'tool' and 'usage' frames
  | { type: 'proposal'; id: string; expiresAt: string; actions: AssistantProposedAction[] }
  | { type: 'done'; stopReason: AssistantStopReason; code: string | null };
```

A `switch (event.type)` then narrows each branch to its own properties. The library's translation overrides use a mapped type, which an interface cannot declare either:

```ts
export type UiPartialTranslations = {
  readonly [Section in keyof UiTranslations]?: Partial<UiTranslations[Section]>;
};
```


## `implements` works with both
A class can implement an interface or an object type alias. It cannot implement a union, because there is no single set of members to check:

```ts
type Shape = { id: number };
class Ok implements Shape { id = 1; }

type Either = { kind: 'a' } | { kind: 'b' };
class Ko implements Either { kind = 'a' as const; }
// error TS2422: A class can only implement an object type or intersection
// of object types with statically known members.
```

In an Angular code base, nearly every `implements` targets a framework interface: `ControlValueAccessor` on the form controls of `@blouppy/ui`, `PipeTransform` on the pipes, `TranslocoLoader` on the translation loader. The keyword of our own types plays no part there.


## One difference that does bite: index signatures
A type alias of an object literal gets an implicit index signature; an interface does not. So an interface value is not assignable to `Record<string, unknown>`:

```ts
interface I1 { id: number }
type T1 = { id: number };

const r1: Record<string, unknown> = {} as I1;
// error TS2322: Type 'I1' is not assignable to type 'Record<string, unknown>'.
//   Index signature for type 'string' is missing in type 'I1'.
const r2: Record<string, unknown> = {} as T1;   // fine
```

Interfaces stay open to merging, so TypeScript cannot promise that no other key will ever appear. In the Starter, the query-parameter models extend Angular's router `Params` (`interface CursorQueryParams extends Params`), which carries the index signature, and the helper that turns them into `HttpParams` takes `object`, so the problem never comes up. It will, the day a function asks for a `Record`.


## What the Starter actually uses
Counting declarations outside the spec files gives a clear pattern:

| Folder | `interface` | `type` | `type X = { … }` |
| --- | --- | --- | --- |
| `front/application/src` | 129 | 76 | 1 |
| `front/application/src/app/core/models` | 92 | 38 | 0 |
| `front/libs/ui/src` | 43 | 47 | 1 |

The API models in `core/models`, which the API services pass to `HttpClient`, are interfaces: `Workspace`, `Notification`, `UserSettings`, `CursorPage<T>`. Their inputs build on each other with `extends`, such as `interface WebhookEdition extends WebhookInputBase`.

The 38 type aliases in that folder are all things an interface cannot be: string unions mirroring the API's enums (`OrganizationRole`, `SubscriptionStatus`, `Colour`), types derived from `as const` arrays (`NotificationType`), the stream union above, a plain rename (`type WebhookCreation = WebhookInputBase`) and one intersection, `type AuditLogQueryParams = AuditLogFilter & CursorQueryParams`, whose two halves never share a property.

`@blouppy/ui` has more aliases than interfaces because its component inputs are mostly closed sets of options:

```ts
export type ButtonVariant = 'solid' | 'outlined' | 'text';

export class ButtonDirective {
  public readonly variant = input<ButtonVariant>('solid');
}
```

Its interfaces describe objects a consumer passes in: `UiMenuItem`, `UiToast`, `UiDialogConfig`. On the application side, an input that takes a model takes the interface, as in `input.required<Notification>()`.

The two `type X = { … }` lines are not object types at all. One is the mapped type above. The other is a component's local state, a union whose first member happens to start with a brace:

```ts
type KeyState = { status: 'loading' } | { status: 'failed' } | { status: 'loaded'; value: OrganizationAiKeyStatus };

public readonly state = signal<KeyState>({ status: 'loading' });
```

A project-management app built on the Starter shows the same split at a larger scale: 435 interfaces, 171 type aliases, and the same single union starting with a brace.


## The lint rule behind it
None of the ESLint configurations in the Starter mentions `consistent-type-definitions`. The pattern comes from a preset: every front-end app and the library extend `tseslint.configs.stylistic`, as described in [Configure ESLint with Angular](/blog/2023-04-03-configure-eslint-with-angular/):

```js
extends: [
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  ...tseslint.configs.stylistic,
  ...angular.configs.tsRecommended,
],
```

The `stylistic` preset turns on `@typescript-eslint/consistent-type-definitions` with its default option, `'interface'`. The rule only reports a type alias whose whole right-hand side is an object literal, `type X = { … }`, with the message "Use an `interface` instead of a `type`.", and `--fix` rewrites it. Unions, mapped types and intersections are left alone, which is exactly why the two lines above pass.

A team that prefers aliases sets the rule to `['error', 'type']`; the fix then turns `extends` clauses into intersections, with the conflict checking lost along the way. The same preset also enables `consistent-indexed-object-style`, which prefers `Record<string, T>` to `{ [key: string]: T }`.


## When it does not matter
For a model that is an object shape, used by an API service and a few components, the choice changes nothing at runtime and nothing in the generated JavaScript. Both are erased. The value of a rule is that the review conversation stops, and a lint rule with a fixer is the cheapest way to get there. Without one, the existing code base's habit is the rule.

It starts to matter in three places: a type meant to be augmented (a library's public surface), a hierarchy where a conflict should fail loudly, and very large compositions where the checker's speed shows.


## Conclusion
The rule of thumb that the Starter follows, and that its lint configuration enforces:

1. An object shape (an API model, the options of a component, a config) is an `interface`, built on others with `extends`.
2. Anything else (a union, a set of string options for an input, a mapped, conditional or derived type) is a `type`.
3. Use `&` only when the parts cannot overlap, and prefer `extends` when they can.

Turn on `tseslint.configs.stylistic`, or `consistent-type-definitions` alone, and let the fixer apply the first point. The rest is rarely worth a review comment.


## References
- [Differences between type aliases and interfaces (TypeScript handbook)](https://www.typescriptlang.org/docs/handbook/2/everyday-types.html#differences-between-type-aliases-and-interfaces) — the official comparison.
- [Declaration merging (TypeScript handbook)](https://www.typescriptlang.org/docs/handbook/declaration-merging.html) — interface merging and module augmentation.
- [Preferring interfaces over intersections (TypeScript wiki)](https://github.com/microsoft/TypeScript/wiki/Performance#preferring-interfaces-over-intersections) — the compiler performance advice.
- [Mapped types (TypeScript handbook)](https://www.typescriptlang.org/docs/handbook/2/mapped-types.html) — `[K in keyof T]`, only available to type aliases.
- [consistent-type-definitions (typescript-eslint)](https://typescript-eslint.io/rules/consistent-type-definitions/) — the rule, its options and its fixer.
- [Shared configs (typescript-eslint)](https://typescript-eslint.io/users/configs/#stylistic) — what the `stylistic` preset enables.
- [Accepting data with input properties (Angular)](https://angular.dev/guide/components/inputs) — `input()` and `input.required()`.
