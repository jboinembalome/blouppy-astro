---
templateKey: 'blog-post'
title: 'Code comments that say why'
date: 2027-03-16T09:00:00.000Z
author: Jimmy Boinembalome
authorimage: /img/jimmy.jpg
category: C#
topic: 'Tooling'
illustration: 2
categorycolor: bg-purple-100 text-purple-800
featuredpost: true
description: >-
  Learn a comment policy for C# and TypeScript: write one only for a non-obvious why, keep the documentation that feeds a contract, and prefer a name, a test or a rule to a comment.
tags:
  - Development
  - C#
  - TypeScript
---

Most code bases have two kinds of comments. The first kind says `// Get the user` above `GetUserAsync`, or `/// <returns></returns>` with nothing inside. The second kind says why a timeout is one minute and not five, and it is the one we are glad to find six months later. The trouble is that the first kind is far more common, and it trains readers to skip comments altogether, the useful ones included.

In this article, we will write down a comment policy: what a comment is for, what replaces most of them, which documentation is a contract and must stay, and when a code base deserves more prose than the policy suggests. The examples come from [Blouppy Starter](https://starter.blouppy.com/), in C# and TypeScript.


## The rule
The Starter's instructions for contributors, human or agent, put it in three sentences:

> Comments only for a non-obvious *why* (a concurrency, security or ordering constraint, a framework workaround), in a sentence or two. No comment that restates a name: `TryGetAsync` on a repository, an explicit property or method needs none. Controller actions keep their short `/// <summary>`, which feeds the OpenAPI spec.

Each part does some work:

- **A why, not a what.** The code already says what it does. What it cannot say is the reason it does it this way, and the alternative we already tried.
- **Non-obvious.** A reason any reader of the stack would guess needs no comment either.
- **Four typical reasons.** Concurrency, security, ordering, and a framework that behaves in a way we work around. These are the places where a well-meaning cleanup breaks something.
- **A sentence or two.** A longer explanation belongs in a design note, linked from the code.
- **Documentation that feeds a contract stays.** It is read by someone who never opens the file.


## What a comment should not do
A few generic examples, of the kind every code base collects:

```csharp
// Get the workspace by id
var workspace = await _workspacesRepository.TryGetAsync(id, cancellationToken);

// Check if the workspace is null
if (workspace is null)
{
    return NotFound();
}

// Increment the retry count
retryCount++;
```

```ts
/**
 * Gets the user name.
 * @returns the user name
 */
getUserName(): string {
  return this.user().userName;
}
```

None of these tells the reader anything the next line does not. They cost twice: once to read, and once to keep in sync. The second cost is the real one, because nothing checks a comment. When `TryGetAsync` starts reading from a cache, the comment above it still says it reads by id, and it is now slightly wrong forever.

The same goes for a few other habits:

- **A changelog in the code.** `// Changed by X on 2025-03-02 to fix the import` is what `git blame` and the commit message are for.
- **Commented-out code.** The history keeps it. In the file, it only raises the question of whether someone meant to bring it back.
- **Empty XML tags.** `/// <param name="cancellationToken"></param>` and `/// <returns></returns>` are the IDE's template, left unfilled. They make a member look documented when it is not.


## Try a name, a test or a rule first
Before writing a comment, it is worth asking whether the code can carry the information itself. Three replacements cover most cases.

**A better name.** A comment that explains a magic number becomes a named constant:

```csharp
// Before
await Task.Delay(120_000, stoppingToken); // wait for the host to start

// After
public static readonly TimeSpan FirstRunDelay = TimeSpan.FromMinutes(2);

await Task.Delay(FirstRunDelay, timeProvider, stoppingToken);
```

**A test.** `// must stay idempotent` above a handler is a wish. A test that runs the handler twice and asserts one row is a guarantee, and it fails the day someone breaks it.

**A rule that fails the build.** `// do not reference the database from here` above a domain class is advice. An architecture test that fails when a domain project references an adapter is a rule. The Starter holds its boundaries this way, as described in [architecture tests that fail the build](/blog/2026-07-03-architecture-tests-that-fail-the-build/). The same applies to a guard in code: when two consumers for one message would silently replace each other, the Starter's `MessagingConfigurator` throws at startup instead of trusting a comment to warn the next developer:

```csharp
if (Consumers.Exists(x => x.MessageType == registration.MessageType))
{
    // One handler per message type and host: a second consumer would replace the first, not join it.
    throw new InvalidOperationException(
        $"{registration.MessageType.Name} already has a consumer in this host; {typeof(TConsumer).Name} cannot be a second one.");
}
```

The comment is still there, and it is a good one: the exception says what is refused, the comment says why Wolverine makes it necessary.


## Comments that earn their place
Here are comments from the Starter that pass the rule, one per kind of reason.

**Security.** `PublicOnlyHttpHandler` builds the `SocketsHttpHandler` for every call to a URL a user typed, such as a webhook endpoint. Each line of it looks like something a cleanup could simplify, so each non-obvious one says why it is there:

```csharp
// The address is checked at connect time, not only on save, so DNS rebinding cannot race it.
// Redirects are off because a 302 would dial a new target without this check.
return new SocketsHttpHandler
{
    AllowAutoRedirect = false,
    UseProxy = false,
    UseCookies = false,
    ConnectTimeout = connectTimeout,
    // The check is not re-run on pooled connections, so keep them short-lived.
    PooledConnectionLifetime = TimeSpan.FromMinutes(1),
    ConnectCallback = async (context, cancellationToken) =>
    {
        // ... resolve, filter the addresses, then:
        // Connect to the checked addresses, never the hostname, which would resolve again unchecked.
        await socket.ConnectAsync(allowed, port, cancellationToken);

        return new NetworkStream(socket, ownsSocket: true);
    }
};
```

Without the third comment, `PooledConnectionLifetime = TimeSpan.FromMinutes(1)` reads like a tuning value someone might raise for performance. With it, the reader knows raising it widens a security gap. The design behind it is in [SSRF-proof outgoing HTTP calls](/blog/2026-07-09-ssrf-proof-outgoing-http-calls-in-dotnet/).

**A framework workaround.** `HybridResponseCache` needs a plain read, and `HybridCache` only offers `GetOrCreateAsync`. The trick is a flag, and the comment names the effect:

```csharp
// Makes the factory unreachable, which is what turns GetOrCreate into a plain read.
private static readonly HybridCacheEntryOptions ProbeOptions = new()
{
    Flags = HybridCacheEntryFlags.DisableUnderlyingData
};
```

The same class catches cache failures with `// A cache is an optimization, never a dependency.`, which is a design decision in eight words.

**Ordering.** Each unit test project of the Starter excludes `DomainEvents` from FluentAssertions comparisons. Doing it in the fixture's static constructor looks equivalent, and is not:

```csharp
public class UnitTestsFixture
{
    // At load, not in a static constructor: a test class outside the collection never creates the fixture, and
    // would otherwise compare DomainEvents whenever it ran before every test that does.
    [ModuleInitializer]
    internal static void ExcludeDomainEvents()
    {
        EquivalencyDefaults.ExcludeDomainEvents();
    }
}
```

**Concurrency.** `TokenPruning` in the identity host is a `BackgroundService`, while the rest of the Starter's recurring jobs run on a clustered Quartz.NET scheduler. A reader would expect the opposite, so the class says why in its `<remarks>`: each replica prunes on its own timer, and that is harmless because both `PruneAsync` calls only delete rows matching a fixed condition, so a second replica running the same hour deletes nothing it should not.

**The same in TypeScript.** The front end follows the same rule:

```ts
disable(confirmation: TwoFactorPasswordConfirmation): Observable<TwoFactorStatus> {
  // A body on DELETE is unusual, but the password is a credential: it has no
  // business in a query string, where it would reach logs and browser history.
  return this._httpClient.delete<TwoFactorStatus>(TwoFactorApiService._baseUrl, { body: confirmation });
}
```

```ts
// Revoking immediately would race the download in Safari; the next tick is enough.
setTimeout(() => URL.revokeObjectURL(url));
```

Each of these protects a line that looks wrong, or at least unusual, from a reviewer who would otherwise "fix" it.

The Starter does not apply the rule perfectly yet. It still has older lines such as `// Register consumers` above a list of `AddConsumer` calls, or `// Initialize form with current user data` in an `ngOnInit`. They are removed when the code around them is touched, rather than in one sweep.


## Documentation that is a contract
Some comments are not read in the file at all. They are published, and then they are part of an API.

**Controller summaries.** A short `/// <summary>` on a controller action can become the operation's description in the OpenAPI document, which client developers read without seeing the controller. In .NET 10, `Microsoft.AspNetCore.OpenApi` picks up XML documentation comments only when the project generates its documentation file (`<GenerateDocumentationFile>true</GenerateDocumentationFile>`). It is worth opening the generated document to check that the summaries actually arrive there. Also note that with `TreatWarningsAsErrors`, generating the file turns `CS1591` (a public member with no XML comment) into a build error, so most projects need a decision about that warning at the same time.

**A library's API reference.** `@blouppy/ui`, the Starter's design-system library, is consumed by four Angular apps. Its playground generates an API table for each component from the library's own TypeScript, and the JSDoc of each `input()`, `model()` and `output()` becomes the description column. A missing description is not a style issue there, so `front/playground/tools/build-api.mjs` fails the build on one:

```js
const undocumented = Object.entries(api).flatMap(([id, page]) =>
  page.classes.flatMap(item =>
    item.members.filter(member => !member.description).map(member => `${id}: ${item.name}.${member.name}`)
  )
);

if (undocumented.length) {
  throw new Error(
    [`${undocumented.length} member(s) have no JSDoc — write one in front/libs/ui/src, where the editor will show it too:`, ...undocumented].join('\n  ')
  );
}
```

The descriptions this produces are short and say what a name cannot:

```ts
/** How many rows there are in total — the server's count, not the page's length. */
public readonly totalRecords = input(0);

/** What the count means: `danger` for something overdue, `secondary` for a neutral total. */
public readonly severity = input<Severity>('primary');
```

Note that the comment is written once, in the library. The editor shows it on hover at every call site, and the playground shows it in the table. A second copy in the harness would drift.


## When to write more
The "sentence or two" rule fits application code, where the readers are the team and the code changes often. Some code deserves more:

- **A public library or package.** Its readers cannot ask the authors, and the documentation is the product. Every public member gets a description, with its edge cases and an example where the usage is not obvious.
- **A tricky algorithm.** A parser, a scheduling rule, a piece of cryptography or a ranking formula benefits from a block at the top that explains the approach, the invariants, and a reference to the paper or the RFC. The header of `build-api.mjs` is an example: a dozen lines on why it uses a real `ts.Program` rather than a regex (`input(false)` names no type, and its `boolean` only exists in the type checker).
- **A protocol or a wire format.** A comment that names the RFC section saves a reader an afternoon.
- **A file that is the entry point of a feature.** A short module-level comment pointing to the design note is cheaper than a reader reconstructing the design from the code.

And sometimes the simpler approach is enough. A small team on a young code base, where everyone reads every pull request, can live with fewer rules and fix comments in review. The policy pays off when the code base outlives its first authors.


## What it costs
- **Judgment.** "Non-obvious" depends on the reader. A reason that is obvious to the author can be obscure to a newcomer, so reviewers should ask "why is this here?" freely, and the answer usually becomes the comment.
- **Discipline in review.** A rule against restating comments has to be applied in review, or the IDE templates win.
- **Reasons still rot.** A why comment can go stale too, when the constraint it names disappears. It happens less often than with a what comment, because the code can change without the reason changing, but it happens. When we remove a workaround, we remove its comment in the same commit.
- **Design notes have to exist.** Keeping comments short moves the long explanations into documentation, which then needs a home and a link.


## Conclusion
A comment is worth writing when it carries information the code cannot: a security constraint, an ordering that looks arbitrary, a concurrency argument, a framework quirk. Everything else is better carried by a name, a test or a rule that fails the build, because those are checked and comments are not. The exceptions are the comments that are published, such as an OpenAPI summary or a library's JSDoc, where the documentation is the contract and a build check can keep it complete.

This is the policy [Blouppy Starter](https://starter.blouppy.com/) follows, and a project-management app built on the Starter applies the same rule word for word.

## References
- [Documentation comments (Microsoft Learn)](https://learn.microsoft.com/dotnet/csharp/language-reference/xmldoc/) — XML documentation comments in C# and `GenerateDocumentationFile`.
- [Recommended XML tags for documentation comments (Microsoft Learn)](https://learn.microsoft.com/dotnet/csharp/language-reference/xmldoc/recommended-tags) — `<summary>`, `<remarks>`, `<param>` and the others.
- [OpenAPI XML documentation comment support in ASP.NET Core (Microsoft Learn)](https://learn.microsoft.com/aspnet/core/fundamentals/openapi/openapi-comments) — how `Microsoft.AspNetCore.OpenApi` reads XML comments into the document.
- [ModuleInitializerAttribute (Microsoft Learn)](https://learn.microsoft.com/dotnet/api/system.runtime.compilerservices.moduleinitializerattribute) — code that runs when an assembly loads.
- [SocketsHttpHandler.ConnectCallback (Microsoft Learn)](https://learn.microsoft.com/dotnet/api/system.net.http.socketshttphandler.connectcallback) — the hook `PublicOnlyHttpHandler` uses to check addresses.
- [HybridCache library in ASP.NET Core (Microsoft Learn)](https://learn.microsoft.com/aspnet/core/performance/caching/hybrid) — the cache behind `HybridResponseCache`.
- [JSDoc reference (TypeScript)](https://www.typescriptlang.org/docs/handbook/jsdoc-supported-types.html) — the JSDoc tags TypeScript understands.
- [Blouppy Starter](https://starter.blouppy.com/) — the starter kit the examples come from.
