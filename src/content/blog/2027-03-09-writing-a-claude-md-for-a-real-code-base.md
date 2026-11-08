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

An AI coding agent opens a repository knowing nothing about it. It does not know that the back end builds from `back/`, that warnings fail the build, that a domain must never reference another domain, or that every user-facing string goes through a translation catalogue. It finds some of this by reading code, guesses the rest, and the guesses show up in the diff: a repository injected into a controller, a hardcoded label, a test named in a style nobody uses.

Claude Code reads a `CLAUDE.md` file at the root of the repository as its project instructions. The file is plain Markdown, so the format is easy; the content is the hard part. Too little and the agent keeps guessing. Too much and the file becomes a second, stale copy of the code base.

In this article, we will look at what goes into a `CLAUDE.md`, what stays out, how repeated workflows move into skills and agents under `.claude/`, and why the rules that matter should be backed by tests rather than by the instructions alone. The real example is the `CLAUDE.md` of [Blouppy Starter](https://starter.blouppy.com/), a .NET 10 and Angular code base on a hexagonal architecture.


## What goes in
A useful test for every line: would a new developer need to be told this, or would they find it in five minutes? The agent is that new developer on every session. Four kinds of content pass.

- **The commands.** How to restore, build, test and lint each part, from which directory, and what a failure means. This is the most used part of the file.
- **The rules, written as statements someone can check.** "References point inward" is a slogan. "A domain never injects another domain's repository, service or model; it calls `IXxxPublicDataService` from that domain's `.PublicData`" can be checked against a diff.
- **Where things live.** The directory layout, which project owns which concern, where a new EF Core configuration goes.
- **The conventions the tools do not enforce.** Test naming, the Arrange / Act / Assert comments, `internal sealed` services with primary constructors.

A minimal file for a small .NET API could be this short:

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

Each rule is short, concrete and names real types. The agent can follow it, and a reviewer can tell whether it was followed.


## The one-line why
A bare rule gets followed literally, and broken the moment the agent meets a case the rule did not foresee. A rule with its reason can be applied to that case. The Starter's file does this throughout, in a sentence at most. On zoneless change detection:

```markdown
- Angular 22 with standalone components and Signals; zoneless change detection
  (`provideZonelessChangeDetection()`) — state read by a template must be a signal,
  plain fields are not picked up
```

On domain registration:

```markdown
**Every domain registers itself.** `AddValidatorsFromAssembly`, `AddBlouppyEvents` and the
integration-event scan all bind to the calling assembly, so
`Blouppy.<Domain>/ServiceCollectionExtensions.cs` must contribute its own — a missing call
breaks nothing at build time and silently stops the domain handling its events.
```

The second one is the kind of rule worth writing down: the failure is silent, so neither the compiler nor a quick look at the code would teach it.


## What stays out
Anything the code or a tool already enforces does not need a paragraph. Prettier settings, ESLint rules and nullable reference types are checked on every build: the agent gets the error and fixes it. Repeating them costs context on every session and adds one more place to update.

Long prose stays out too. The Starter keeps its design notes in `front/docs/internal/` and a README per app, and the `CLAUDE.md` points to them instead of copying them:

```markdown
Each app has a README worth reading before working in it:
[`front/application/`](front/application/README.md),
[`front/landing/`](front/landing/README.md), [`front/docs/`](front/docs/README.md),
[`front/playground/`](front/playground/README.md),
[`front/libs/ui/`](front/libs/ui/README.md), [`back/`](back/README.md),
[`e2e/`](e2e/README.md).
```

A link costs one line and stays correct when the README changes. A copy is correct on the day it is pasted.


## Skills and agents for the repeated workflows
Some knowledge is only needed for one kind of task. Adding an EF Core entity in the Starter means a domain class, a strongly-typed id, a configuration with the right base class, a HiLo sequence for an `int` key, a repository and a migration. Putting all of that in `CLAUDE.md` would make every session pay for it. The Starter puts it in a skill instead, `.claude/skills/adding-ef-core-entity/SKILL.md`, a Markdown file with a short front matter:

```markdown
---
user-invocable: false
name: adding-ef-core-entity
description: Guide for adding a new persisted entity to Blouppy using EF Core + PostgreSQL.
  Use when adding a new domain entity that needs to be stored in the database.
---
```

The `description` says when the skill applies. The `CLAUDE.md` lists two groups: background skills such as this one, which the agent uses on its own when the task fits, and user-invocable skills such as `/fix-ci` or `/review-backend`, which a person starts from the `/` menu. The review skill names the agent it runs with and the tools it may use:

```markdown
---
name: review-backend
description: Review Blouppy backend changes (Domain, Application, Infrastructure)
disable-model-invocation: true
context: fork
agent: backend-reviewer
allowed-tools: Bash(git diff *) Bash(git log *) Read Grep Glob
---
```

The agents live in `.claude/agents/`, one Markdown file each with its own instructions and tool list. `backend-reviewer` and `angular-reviewer` may read and search but not write; `plan-fix` produces a plan and is told never to edit code.

Two more pieces sit beside them. `.claude/rules/` holds conventions scoped by path, for example `testing.md` with `paths: ["**/*.UnitTests/**/*.cs", ...]` in its front matter, so the testing rules come with the test files. And `.claude/settings.json` lists the commands the agent may run without asking (`dotnet build`, `dotnet test`, `npm run`) and the ones it may not (`git push --force`, `rm -rf`, reading `.env`).


## Back the rules with tests
Here is the honest limit: an instruction is not a guarantee. The agent can miss a line in a long file, misread a rule, or follow an older pattern it found in the code. A rule that only lives in `CLAUDE.md` is a wish, exactly like a rule that only lives in a wiki.

So the rules that matter in the Starter are also tests, and the `CLAUDE.md` says so: "`Blouppy.Architecture.UnitTests/Architecture/` fails the build on a broken boundary rather than leaving it to review". We covered how those tests read the compiled assemblies in [Architecture tests that fail the build](/blog/2026-07-03-architecture-tests-that-fail-the-build/). The instruction tells the agent the rule before it writes code. The test catches it when it did not listen.

The audit log is a good example. The `CLAUDE.md` says that a write added to an `IXxxService` needs a row in `AuditCoverage.cs`, audited or not with a reason. The file itself is a dictionary that a test compares with every write method the driving ports declare:

```csharp
namespace Blouppy.Architecture.UnitTests.Architecture;

internal static class AuditCoverage
{
    public abstract record Row;

    public sealed record Audited(params AuditEventType[] EventTypes) : Row;

    public sealed record NotAudited(string Reason) : Row;

    public static readonly IReadOnlyDictionary<string, Row> Rows = new Dictionary<string, Row>
    {
        ["IOrganizationMembersService.TryUpdateAsync"] = new Audited(AuditEventType.MemberRoleChanged),
        ["IOrganizationMembersService.TryDeleteAsync"] = new Audited(AuditEventType.MemberRemoved),
        ["IDataExportService.TryRequestAsync"] = new NotAudited("A person's own, not the organization's administration"),
    };
}
```

An agent that adds a service method and forgets the row gets a red `AuditCoverageTests` with the method's name in it. The instruction and the test say the same thing, and only one of them can be ignored.

The same pairing holds for the AI gateway. The file says "An AI feature never injects `ILlmClient`", and `LlmBoundaryTests` scans every assembly the API host is composed of and fails when any type other than `AiGateway` injects it.

A useful habit follows: when a rule in `CLAUDE.md` matters enough to be written in bold, ask whether a test could hold it. If one can, write the test and keep the sentence as the explanation. If none can, as for test naming or the one-line comments style, the sentence is all there is, and review has to do the rest.


## Keeping it up to date
A `CLAUDE.md` rots like any documentation, with one difference: a stale line is not ignored by a reader who knows better. It is followed. A file that still says "PrimeNG for components" after PrimeNG was removed will produce PrimeNG imports. The Starter's file states such removals explicitly ("PrimeNG was removed in full, so a missing primitive is added to `@blouppy/ui`"), because the old pattern can still be found in older code and examples.

Two practices keep the file honest:
- **Change it in the same pull request as the code.** A new module, a renamed project or a new build command is a change to `CLAUDE.md` too.
- **Let the tests carry the rules.** When a test holds a boundary, the sentence that describes it can be wrong only in its wording, not in its effect.


## The costs, and when a short file is enough
The Starter's `CLAUDE.md` is 557 lines. That is long, and it has a price: it is read on every session whatever the task, and the longer the file, the easier it is for one rule to be missed. Much of the length comes from the architecture tables, which a small project does not have. Moving task-specific guidance into skills is the main way to pay that price only when it is needed.

The other cost is maintenance across copies: a project-management app built on the Starter carries its own `CLAUDE.md` on the same skeleton, and a convention that changes in one has to be considered in the other.

For a small service with one project and a conventional layout, none of this machinery is needed. A file of twenty lines with the build and test commands and three or four rules the code does not show is enough. Skills, agents and path-scoped rules start to pay off when the same multi-step task comes back every week, when several parts of the repository have different conventions, or when the architecture has rules that a newcomer, human or not, would break on the first day.


## Conclusion
A good `CLAUDE.md` is short on prose and long on facts: the commands, the rules as statements that can be checked against a diff, the reason behind each rule in a sentence, and links to where the longer explanations live. Workflows that come back go into skills and agents under `.claude/`, so the main file stays focused. The rules that matter are also tests, because the instructions tell the agent what to do and only the build can tell whether it did.


## References
- [Claude Code: memory and CLAUDE.md](https://code.claude.com/docs/en/memory) — how Claude Code reads project instructions.
- [Claude Code: skills](https://code.claude.com/docs/en/skills) — skill files and their front matter.
- [Claude Code: subagents](https://code.claude.com/docs/en/sub-agents) — agent definitions in `.claude/agents/`.
- [Claude Code: settings](https://code.claude.com/docs/en/settings) — `settings.json` and permission rules.
- [NetArchTest](https://www.nuget.org/packages/NetArchTest.Rules) — the library behind part of the Starter's architecture tests.
- [Blouppy Starter](https://starter.blouppy.com/) — the code base this article takes its examples from.
