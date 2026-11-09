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

Most code bases have two kinds of comments. The first says `// Get the user` above `GetUserAsync`. The second says why a timeout is one minute and not five, and it is the one we are glad to find six months later.

The first kind is far more common. It trains readers to skip comments altogether, the useful ones included.


## The rule
The contributor instructions of [Blouppy Starter](https://starter.blouppy.com/), for humans and agents alike, put it in three sentences:

> Comments only for a non-obvious *why* (a concurrency, security or ordering constraint, a framework workaround), in a sentence or two. No comment that restates a name: `TryGetAsync` on a repository, an explicit property or method needs none. Controller actions keep their short `/// <summary>`, which feeds the OpenAPI spec.

The code already says what it does. What it cannot say is why it does it this way, or which alternative was already tried. The four reasons listed are the places where a well-meaning cleanup breaks something. Anything longer than a sentence or two belongs in a design note, linked from the code.


## What a comment should not do
A few lines every code base collects:

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

None of these tells the reader anything the next line does not. They cost twice: once to read, and once to keep in sync. The second cost is the real one, because nothing checks a comment. When `TryGetAsync` starts reading from a cache, the comment still says it reads by id, and it is now slightly wrong forever.

The same goes for a changelog in the code, which is what `git blame` is for, and for commented-out code, which the history keeps. Empty XML tags, `/// <returns></returns>`, are the IDE's template left unfilled. They make a member look documented when it is not.


## A name, a test or a rule first
Before writing a comment, ask whether the code can carry the information itself. A comment that explains a magic number becomes a named constant:

```csharp
// Before
await Task.Delay(120_000, stoppingToken); // wait for the host to start

// After
public static readonly TimeSpan FirstRunDelay = TimeSpan.FromMinutes(2);

await Task.Delay(FirstRunDelay, stoppingToken);
```

`// must stay idempotent` above a handler is a wish. A test that runs the handler twice and asserts one row is a guarantee. `// do not reference the database from here` is advice. An [architecture test that fails the build](/blog/2026-07-03-architecture-tests-that-fail-the-build/) is a rule. Names, tests and rules are checked. Comments are not.


## Comments that earn their place
What is left is the information the code cannot carry. The Starter's `PublicOnlyHttpHandler` is a good example. It builds the HTTP handler for every call to a URL a user typed, such as a webhook endpoint. Each of its settings looks like something a cleanup could simplify, so each non-obvious one says why it is there (trimmed):

```csharp
// The address is checked at connect time, not only on save, so DNS rebinding cannot race it.
// Redirects are off because a 302 would dial a new target without this check.
return new SocketsHttpHandler
{
    AllowAutoRedirect = false,
    // The check is not re-run on pooled connections, so keep them short-lived.
    PooledConnectionLifetime = TimeSpan.FromMinutes(1),
    ConnectCallback = async (context, cancellationToken) =>
    {
        // ... resolve the host, keep only the public addresses, then:
        // Connect to the checked addresses, never the hostname, which would resolve again unchecked.
        await socket.ConnectAsync(allowed, port, cancellationToken);

        return new NetworkStream(socket, ownsSocket: true);
    }
};
```

Without the third comment, a one-minute connection lifetime reads like a tuning value someone might raise for performance. With it, the reader knows that raising it widens a security gap. The design is in [SSRF-proof outgoing HTTP calls](/blog/2026-07-09-ssrf-proof-outgoing-http-calls-in-dotnet/).

A framework workaround deserves the same. `HybridCache` only offers `GetOrCreateAsync`, and the Starter needs a plain read. The trick is a flag, and its comment names the effect: `// Makes the factory unreachable, which is what turns GetOrCreate into a plain read.` The same class catches cache failures with `// A cache is an optimization, never a dependency.`, a design decision in eight words.

Each of these protects a line that looks wrong, or at least unusual, from a reviewer who would otherwise "fix" it.

The Starter does not apply the rule perfectly yet. A few older lines such as `// Register consumers` above a list of registrations are still there. They go when the code around them is touched, rather than in one sweep.


## Documentation that is a contract
Some comments are not read in the file at all. They are published, and then they are part of an API.

A controller action's `/// <summary>` becomes the operation's description in the OpenAPI document, read by client developers who never see the controller. With `Microsoft.AspNetCore.OpenApi`, that only happens when the project sets `GenerateDocumentationFile`. With `TreatWarningsAsErrors`, that setting also turns `CS1591`, a public member without a comment, into a build error, so it comes with a decision about that warning.

The Starter's design-system library goes further. Its playground generates an API table per component from the JSDoc of each `input()` and `output()`, and its build fails on a member with none. The descriptions say what a name cannot:

```ts
/** How many rows there are in total — the server's count, not the page's length. */
public readonly totalRecords = input(0);
```

The comment is written once, in the library. The editor shows it on hover at every call site, and the playground shows it in its table.


## When to write more
"A sentence or two" fits application code, where the readers are the team and the code changes often. A public package deserves more, since its readers cannot ask the authors and the documentation is the product. So does a parser or a scheduling rule, with a block at the top on the approach and its invariants, and a protocol, where naming the RFC section saves an afternoon.

A why comment can go stale too, when the constraint it names disappears. It happens less often than with a what comment, because the code can change without the reason changing. When we remove a workaround, we remove its comment in the same commit.


## References
- [Recommended XML tags for documentation comments](https://learn.microsoft.com/dotnet/csharp/language-reference/xmldoc/recommended-tags) — Microsoft Learn: `<summary>`, `<remarks>` and the others.
- [OpenAPI XML documentation comment support in ASP.NET Core](https://learn.microsoft.com/aspnet/core/fundamentals/openapi/openapi-comments) — Microsoft Learn: how XML comments reach the document.
- [JSDoc reference](https://www.typescriptlang.org/docs/handbook/jsdoc-supported-types.html) — TypeScript: the JSDoc tags it understands.
