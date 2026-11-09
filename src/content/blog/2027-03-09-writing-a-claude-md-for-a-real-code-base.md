---
templateKey: 'blog-post'
title: 'Writing a CLAUDE.md for a real code base'
date: 2027-03-09T09:00:00.000Z
author: Jimmy Boinembalome
authorimage: /img/jimmy.jpg
category: C#
topic: 'Tooling'
illustration: 3
categorycolor: bg-purple-100 text-purple-800
featuredpost: true
description: >-
  Learn what to put in the CLAUDE.md of a full-stack code base, what to leave to the code and its tests, and how skills, agents and architecture tests keep the instructions honest.
tags:
  - Development
  - Architecture
  - Testing
---

An AI coding agent opens a repository knowing nothing about it. It does not know that warnings fail the build, that a domain must never reference another domain, or that every label goes through a translation catalogue. It finds some of this by reading code and guesses the rest. The guesses show up in the diff: a repository injected into a controller, a hardcoded label, a test named in a style nobody uses.

Claude Code reads a `CLAUDE.md` file at the root of the repository as its project instructions. The format is plain Markdown. The content is the hard part: too little and the agent keeps guessing, too much and the file becomes a stale second copy of the code base.


## What goes in
A useful test for every line: would a new developer need to be told this, or would they find it in five minutes? The agent is that new developer on every session. What passes is the commands, the rules, where things live, and the conventions no tool enforces. A minimal file for a small .NET API can be this short:

```markdown
# Orders API

## Build & Test
dotnet build src/        # warnings are errors
dotnet test src/         # unit + integration (needs Docker for Testcontainers)

## Rules
- Controllers inject an `IXxxService`, never a repository or the `DbContext`.
- EF Core configuration lives in `Infrastructure/<Feature>/`; no EF attributes on domain classes.
- Every write returns `ValidationResult<T>`; a controller maps a failure to 400.
```

Each rule is short and names real types. "References point inward" is a slogan. "Controllers inject an `IXxxService`, never a repository" can be checked against a diff, by the agent and by the reviewer.


## A rule with its reason
A bare rule gets followed literally, then broken the first time the agent meets a case the rule did not foresee. A rule with its reason can be applied to that case. The `CLAUDE.md` of [Blouppy Starter](https://starter.blouppy.com/), a .NET 10 and Angular code base, gives the reason in a sentence at most:

```markdown
**Every domain registers itself.** `AddValidatorsFromAssembly`, `AddBlouppyEvents` and the
integration-event scan all bind to the calling assembly, so
`Blouppy.<Domain>/ServiceCollectionExtensions.cs` must contribute its own — a missing call
breaks nothing at build time and silently stops the domain handling its events.
```

This is the kind of rule worth writing down. The failure is silent, so neither the compiler nor a quick look at the code would teach it.


## What stays out
Anything a tool already enforces does not need a paragraph. Prettier settings, ESLint rules and nullable reference types are checked on every build: the agent gets the error and fixes it. Repeating them costs context on every session, and adds one more place to update.

Long prose stays out too. The Starter keeps its design notes in a docs folder and a README per app, and the `CLAUDE.md` links to them. A link stays correct when the README changes. A copy is correct on the day it is pasted.

Knowledge needed for one kind of task stays out as well. Adding an EF Core entity in the Starter means a domain class, a typed id, a configuration, a HiLo sequence, a repository and a migration. Every session would pay for that list in `CLAUDE.md`. So it lives in a **skill**, `.claude/skills/adding-ef-core-entity/SKILL.md`, whose front matter says when it applies, and the agent loads it only when the task fits. `.claude/agents/` holds narrower roles, such as a reviewer that may read and search but not write. `.claude/rules/` holds rules scoped by path, so the testing conventions come with the test files.


## Back the rules with tests
An instruction is not a guarantee. The agent can miss a line in a long file, misread a rule, or copy an older pattern it found in the code. A rule that only lives in `CLAUDE.md` is a wish, like a rule that only lives in a wiki.

So the rules that matter in the Starter are also tests, described in [Architecture tests that fail the build](/blog/2026-07-03-architecture-tests-that-fail-the-build/). The audit log is a good example. The `CLAUDE.md` says that a write added to an `IXxxService` needs a row in `AuditCoverage.cs`, audited or not with a reason. That file is a dictionary, and a test compares it with every write method the driving ports declare (trimmed):

```csharp
public static readonly IReadOnlyDictionary<string, Row> Rows = new Dictionary<string, Row>
{
    ["IOrganizationMembersService.TryUpdateAsync"] = new Audited(AuditEventType.MemberRoleChanged),
    ["IOrganizationMembersService.TryDeleteAsync"] = new Audited(AuditEventType.MemberRemoved),
    ["IOrganizationsService.TryDeleteAsync"] = new NotAudited(
        "The organization's audit log is deleted with it: there is no log left to record it in"),
};
```

An agent that adds a service method and forgets the row gets a red `AuditCoverageTests` with the method's name in it. The instruction tells the agent the rule before it writes code. The test catches it when it did not listen.

A habit follows. When a rule matters enough to be written in bold, ask whether a test could hold it. If one can, write the test and keep the sentence as the explanation. If none can, as for test naming, the sentence is all there is, and review does the rest.


## A stale line is followed
A `CLAUDE.md` rots like any documentation, with one difference: a stale line is not ignored by a reader who knows better. It is followed. A file that still says "PrimeNG for components" after PrimeNG was removed produces PrimeNG imports. The Starter's file states the removal explicitly, "PrimeNG was removed in full, so a missing primitive is added to `@blouppy/ui`", because the old pattern still exists in older code and examples.

So the file changes in the same pull request as the code. A new module, a renamed project or a new build command is a change to `CLAUDE.md` too.


## How long?
The Starter's `CLAUDE.md` is 557 lines. That is long, and it has a price: it is read on every session whatever the task, and in a long file one rule is easier to miss. Most of the length comes from architecture tables a small project does not have.

For a small service with a conventional layout, twenty lines are enough: the build and test commands, and three or four rules the code does not show. Skills, agents and scoped rules pay off when the same multi-step task comes back every week, or when the architecture has rules a newcomer, human or not, would break on the first day.


## References
- [Claude Code: memory and CLAUDE.md](https://code.claude.com/docs/en/memory) — how Claude Code reads project instructions.
- [Claude Code: skills](https://code.claude.com/docs/en/skills) — skill files and their front matter.
- [Claude Code: subagents](https://code.claude.com/docs/en/sub-agents) — agent definitions in `.claude/agents/`.
