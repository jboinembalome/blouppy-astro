---
templateKey: 'blog-post'
title: 'Commit messages and pull requests a reviewer can read'
date: 2027-03-18T09:00:00.000Z
author: Jimmy Boinembalome
authorimage: /img/jimmy.jpg
category: C#
topic: 'Tooling'
illustration: 3
categorycolor: bg-purple-100 text-purple-800
featuredpost: true
description: >-
  Write commits and pull requests a reviewer can follow: one change per commit, an imperative subject, a body that says why, small PRs, a short template, labels for slow suites and squash merges.
tags:
  - Development
  - GitHub
  - Tips
---

A pull request lands with forty files and three commits: `wip`, `fix`, `fix tests`. The reviewer opens the diff, scrolls, and has to guess which change is the point and which ones came along for the ride. Six months later, `git blame` on a strange line leads to `fix`, and nobody remembers what was broken.

The history of a repository is read far more often than it is written. In this article, we will see what makes a commit and a pull request readable: one change per commit, a subject in the imperative, a body that says why, branch names, small pull requests, a short template, labels that trigger slow suites, the merge strategy, and what never belongs in a commit. The real example is the workflow of [Blouppy Starter](https://starter.blouppy.com/), a .NET 10 and Angular starter kit.


## One change per commit
A commit is the unit a reviewer reads, `git revert` undoes and `git bisect` tests. It should hold one change that makes sense on its own: a rename, a bug fix, a new endpoint. A rename mixed with a fix turns a five-line fix into a two-hundred-line diff, and reverting the fix brings the old names back.

Git can split work after the fact. `git add -p` stages a file hunk by hunk, so two unrelated edits in the same file end up in two commits:

```bash
git add -p src/Workspaces/WorkspaceService.cs   # pick the hunks of the fix
git commit -m "fix: reject a workspace name made of spaces"
git add -A
git commit -m "refactor: rename WorkspaceInput to CreateWorkspaceInput"
```

When review asks for a change to an earlier commit, `git commit --fixup <sha>` records it as a fixup of that commit, and `git rebase -i --autosquash main` folds it in before merging.

A useful test: each commit should build and pass its tests. `git bisect` relies on it, and a commit that does not compile is a commit nobody can check out.


## A subject in the imperative
The subject line is what `git log --oneline`, GitHub's commit list and every changelog tool show. Three habits make it readable:

- **The imperative mood.** Write `add`, `fix`, `remove`, as if completing the sentence "If applied, this commit will…".
- **Short.** About 50 characters is the usual target, 72 a hard limit: longer subjects are cut off in GitHub's lists and in many terminals.
- **Specific.** `fix: reject a workspace name made of spaces` says what changed. `fix bug` and `update service` say nothing that the diff does not.

The Starter's history has subjects like this one:

```text
feat: one page frame, one width per context, paragraphs held to 65 characters
```

It is a pull request squashed into one commit (more on that below), so the subject summarizes the whole change. A project-management app built on the Starter writes the same way, with subjects like `tech: stabilize the back-end test suite`.


## A body that says why
The diff already shows what changed. The body is the only place that can say **why**: the bug it fixes, the constraint that forced the approach, the alternative that was rejected. Separate it from the subject with a blank line, and wrap it at about 72 characters:

```text
fix: keep the session when the token refresh times out

The gateway signed the user out whenever the identity host did not
answer the refresh in time. A slow identity host is not an expired
session: we now keep the cookie and retry on the next request, and
only sign out when the refresh is refused.

Fixes #12
```

The last lines are **trailers**. GitHub closes the issue when a commit with `Fixes #12` (or `Closes`, `Resolves`) reaches the default branch, and shows both authors for `Co-authored-by: Name <email>`. They cost nothing and link the history to the reason it exists.

Not every commit needs a body. `docs: fix a typo in the README` is complete. The body is for the commit someone will one day find through `git blame` and wonder about.


## Conventional Commits, when the tooling pays off
[Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/) is a format for the subject: `<type>[optional scope]: <description>`, with `feat` and `fix` defined by the spec, `!` or a `BREAKING CHANGE:` footer for a breaking change, and other types left to the project. Its real benefit is machine-readable history. Tools such as semantic-release or release-please read it to choose the next version number and write the changelog, and commitlint can reject a message that does not follow it. The [Husky article](/blog/2023-05-14-configure-husky-with-angular/) sets up that commit hook in an Angular project.

The cost is small but real: a vocabulary to learn, and a hook that sometimes blocks a commit for a missing type. If nothing reads the types (no generated changelog, no automatic versioning), a plain imperative subject carries the same information. The format is worth it when a tool consumes it, or when a team wants the history filtered by kind of change.

The Starter uses a lighter variant, described in its `git-workflow` skill: `<type>: <short description>`, imperative and lowercase, with the types `feat`, `fix`, `refactor`, `hotfix`, `test`, `docs` and `tech`. `tech` covers tooling, configuration and CI. It is not one of the types that `@commitlint/config-conventional` accepts, so a project with its own vocabulary that adds commitlint has to set the `type-enum` rule to its own list:

```js
// commitlint.config.mjs
export default {
  extends: ['@commitlint/config-conventional'],
  rules: {
    'type-enum': [2, 'always', ['feat', 'fix', 'refactor', 'hotfix', 'test', 'docs', 'tech']],
  },
};
```


## Branch names
A branch name is read in the pull request list, in CI runs and in the terminal. The Starter mirrors the commit types: `<type>/<short-description>`, lowercase and kebab-case, with the prefixes `feature/`, `fix/`, `refactor/`, `hotfix/`, `test/`, `docs/` and `tech/`:

```bash
git checkout -b feature/add-workspace-member
```

The prefix tells a reviewer what kind of change to expect before opening it, and CI rules can match on it if they need to.


## Small pull requests
The Starter's guidelines for a pull request are four lines: one concern per pull request, kept small, against `main` with the template filled in, and every check green before asking for review.

Size matters most. A reviewer reads a 200-line diff carefully and skims a 2,000-line one. When a feature is large, it can usually be cut along its seams: the migration and the entity first, then the service and its tests, then the endpoint, then the UI. Each pull request is reviewable on its own, and the early ones can merge while the later ones are still being written.

Mixing concerns is the other trap. A refactor that rides along with a fix makes the fix hard to find and impossible to revert alone. Open the refactor as its own pull request, merge it, then rebase the fix on top.


## A template with a few useful headings
A pull request template is a Markdown file, `.github/pull_request_template.md`, that GitHub copies into the description of every new pull request. The Starter's has four headings:

```markdown
## Description
Briefly describe the changes introduced by this pull request.

## Motivation & Impact
Explain why this change is necessary and describe what parts of the project are impacted

## Tests
How the changes were tested:
- [ ] unit tests
- [ ] integrations tests
- [ ] e2e tests

## Links (optional)
Related PR(s):
```

Each heading answers a question the reviewer would otherwise ask in a comment: what is this, why, what does it touch, how do we know it works. The checklist is short on purpose. A template with fifteen boxes trains people to tick them all without reading, and then it says nothing.


## Labels that trigger slow suites
Some checks are too slow for every push. The Starter's [end-to-end suite](/blog/2026-09-25-end-to-end-tests-with-aspire-hosting-testing/) boots the whole graph and takes a few minutes, so its workflow runs on a version tag, by hand, and on a pull request that carries the `e2e 🧪` label:

```yaml
# .github/workflows/e2e.yml (trimmed)
on:
  pull_request:
    branches: [ main ]
    types: [ opened, reopened, synchronize, labeled ]
  push:
    tags: [ 'v*' ]
  workflow_dispatch:

jobs:
  e2e:
    if: >-
      github.event_name != 'pull_request'
      || (contains(github.event.pull_request.labels.*.name, 'e2e 🧪')
          && (github.event.action != 'labeled' || github.event.label.name == 'e2e 🧪'))
```

The `labeled` type starts the suite as soon as someone adds the label, and `synchronize` runs it again on each push while the label stays on. The second half of the condition skips the run when the label just added is a different one.

The Starter also labels pull requests by path with `actions/labeler`, and its configuration puts `e2e 🧪` on any pull request that changes `e2e/**` or the workflow itself. There is a catch, documented in that file: a label added with the `GITHUB_TOKEN` starts no workflow, so the suite only runs on the next push. Labels a person adds do start it.


## Squash or merge
GitHub offers three ways to merge a pull request:

- **Merge commit** keeps every commit of the branch and adds one merge commit. The history is complete, and only as readable as the branch was.
- **Squash and merge** turns the whole pull request into a single commit on `main`. The Starter uses it: GitHub can be set to take the pull request title as the subject and appends the number, which is how its history reads `feat: one page frame… (#N)`.
- **Rebase and merge** replays each commit on top of `main` without a merge commit.

Squashing suits small pull requests: `main` gets one readable commit per change, and the `wip` commits of the branch vanish. The cost is the detail inside: a pull request with a rename commit and a fix commit becomes one commit, and reverting the fix alone is no longer possible. If commits are curated, a merge commit or a rebase keeps them. With squash, the pull request title becomes the commit subject, so it deserves the same care as a commit message.


## What not to put in a commit
Some files never belong in history:

- **Secrets.** API keys, connection strings, certificates. The Starter's `.gitignore` excludes `.env` and `.env.*` and tracks only `.env.example`, a documented template, and excludes `*.pfx`. Once a secret is pushed, removing it in a new commit is not enough: it stays in history and in every clone. Rotate it first, then clean the history if needed. GitHub's secret scanning with push protection blocks many known token formats before they land.
- **Build output.** `bin/`, `obj/`, `dist/` and `node_modules/` are rebuilt from source and only make diffs noisy.
- **Generated files nobody reviews.** The Starter's documentation site compiles Markdown into Angular components in a git-ignored folder.

Generated is not always excluded, though. The Starter commits its EF Core migrations, its published OpenAPI spec under `api/`, and its Mermaid diagrams rendered to SVG, so CI and Docker build without a browser. The rule is whether the file is read or needed by something that cannot regenerate it. A committed generated file then gets reviewed like code: a migration diff is exactly where a reviewer wants to look.


## When not to bother
All of this is for history that other people read. On a solo prototype, a spike that will be thrown away or a branch that will be squashed, `wip` commits are fine: the squash removes them, and only the pull request title and description survive. Conventional Commits without a tool reading them is ceremony. A template is overkill for a repository with one contributor. What stays useful at any size is a specific subject and a body for the commit someone will find through `git blame`.


## Conclusion
A readable history is cheap to write and expensive to reconstruct. One change per commit keeps reverts and bisects precise; an imperative, specific subject makes `git log` scannable; a body records the why that the diff cannot. On the pull request side, small and single-concern changes get real reviews, a short template asks the reviewer's questions in advance, a label keeps slow suites on demand, and squash merges turn each pull request into one commit on `main`.

## References
- [Conventional Commits 1.0.0](https://www.conventionalcommits.org/en/v1.0.0/) — the specification for typed commit subjects.
- [git-commit (Git documentation)](https://git-scm.com/docs/git-commit) — `--fixup`, `-m` and the discussion of commit messages.
- [git-rebase (Git documentation)](https://git-scm.com/docs/git-rebase) — `--autosquash` and interactive rebase.
- [git-interpret-trailers (Git documentation)](https://git-scm.com/docs/git-interpret-trailers) — the trailer lines at the end of a message.
- [Linking a pull request to an issue (GitHub Docs)](https://docs.github.com/issues/tracking-your-work-with-issues/using-issues/linking-a-pull-request-to-an-issue) — `Fixes`, `Closes` and `Resolves`.
- [Creating a pull request template (GitHub Docs)](https://docs.github.com/communities/using-templates-to-encourage-useful-issues-and-pull-requests/creating-a-pull-request-template-for-your-repository) — where the template lives.
- [About merge methods on GitHub (GitHub Docs)](https://docs.github.com/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/about-merge-methods-on-github) — merge, squash and rebase.
- [Triggering a workflow from a workflow (GitHub Docs)](https://docs.github.com/actions/using-workflows/triggering-a-workflow#triggering-a-workflow-from-a-workflow) — why a `GITHUB_TOKEN` label starts no workflow.
- [actions/labeler (GitHub)](https://github.com/actions/labeler) — labels a pull request by the paths it changes.
- [About push protection (GitHub Docs)](https://docs.github.com/code-security/secret-scanning/introduction/about-push-protection) — blocking secrets before they are pushed.
- [commitlint](https://commitlint.js.org/) — checks commit messages against a convention.
