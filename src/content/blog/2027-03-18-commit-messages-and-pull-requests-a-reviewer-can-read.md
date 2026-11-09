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

A pull request lands with forty files and three commits: `wip`, `fix`, `fix tests`. The reviewer opens the diff and has to guess which change is the point and which ones came along for the ride. Six months later, `git blame` on a strange line leads to `fix`, and nobody remembers what was broken.

The history of a repository is read far more often than it is written. A few habits make it readable.


## One change per commit
A commit is the unit a reviewer reads, `git revert` undoes and `git bisect` tests. It should hold one change that makes sense on its own: a rename, a bug fix, a new endpoint. A rename mixed with a fix turns a five-line fix into a two-hundred-line diff, and reverting the fix brings the old names back.

Git can split the work after the fact. `git add -p` stages a file hunk by hunk, so two unrelated edits in the same file end up in two commits:

```bash
git add -p src/Orders/OrderService.cs   # pick the hunks of the fix
git commit -m "fix: reject an order with no line"
git add -A
git commit -m "refactor: rename OrderInput to CreateOrderInput"
```

When review asks for a change to an earlier commit, `git commit --fixup <sha>` records it against that commit, and `git rebase -i --autosquash main` folds it in before merging. Each commit should also build and pass its tests: `git bisect` relies on it.


## The subject and the body
The subject line is what `git log --oneline` and GitHub's commit list show. Write it in the imperative, as if completing "If applied, this commit will…". Keep it near 50 characters, 72 at most, since longer ones get cut off. And make it specific: `fix: reject an order with no line` says what changed, `fix bug` says nothing the diff does not.

The diff already shows what changed. The body is the only place that can say **why**: the bug it fixes, the constraint behind the approach, the alternative that was rejected. A blank line separates it from the subject:

```text
fix: keep the session when the token refresh times out

The gateway signed the user out whenever the identity server did not
answer the refresh in time. A slow server is not an expired session:
we now keep the cookie and retry on the next request, and only sign
out when the refresh is refused.

Fixes #12
```

The last line is a **trailer**. GitHub closes the issue when a commit with `Fixes #12` reaches the default branch. Not every commit needs a body, though: `docs: fix a typo in the README` is complete. The body is for the commit someone will one day find through `git blame` and wonder about.

The `fix:` prefix comes from [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/). Its real benefit is a machine-readable history: semantic-release or release-please read it to pick the next version and write the changelog. If no tool reads the types, a plain imperative subject carries the same information. [Blouppy Starter](https://starter.blouppy.com/) uses a light variant with its own types, `feat`, `fix`, `refactor`, `hotfix`, `test`, `docs` and `tech`, and branch names that mirror them: `feature/add-workspace-member`.


## Small pull requests
A reviewer reads a 200-line diff carefully and skims a 2,000-line one. A large feature can usually be cut along its seams: the migration and the entity first, then the service and its tests, then the endpoint, then the UI. Each pull request is reviewable on its own, and the early ones can merge while the later ones are being written. A refactor that rides along with a fix is the other trap: it makes the fix hard to find and impossible to revert alone.

A pull request template, `.github/pull_request_template.md`, asks the reviewer's questions in advance. The Starter's has four headings: what changed, why and what it touches, how it was tested, and related links. The testing checklist has three boxes. A template with fifteen trains people to tick them all without reading.


## Slow suites on demand
Some checks are too slow for every push. The Starter's [end-to-end suite](/blog/2026-09-25-end-to-end-tests-with-aspire-hosting-testing/) boots the whole system and takes a few minutes, so it runs on a version tag, by hand, and on a pull request labelled `e2e 🧪` (trimmed):

```yaml
on:
  pull_request:
    types: [opened, reopened, synchronize, labeled]
  push:
    tags: ['v*']
  workflow_dispatch:

jobs:
  e2e:
    if: >-
      github.event_name != 'pull_request'
      || (contains(github.event.pull_request.labels.*.name, 'e2e 🧪')
          && (github.event.action != 'labeled' || github.event.label.name == 'e2e 🧪'))
```

Adding the label starts the suite, and each push runs it again while the label stays on. The second half of the condition skips the run when the label just added is a different one. The Starter also adds labels by path with `actions/labeler`, with one catch: a label added with the `GITHUB_TOKEN` starts no workflow, so the suite only runs on the next push.


## Squash, and what stays out
The Starter squashes each pull request into one commit on `main`, with the pull request title as the subject and its number appended: `fix: dispose the auto-removed test containers without stopping them first (#61)`. The `wip` commits of the branch vanish. The cost is the detail inside: a rename commit and a fix commit become one, and the fix can no longer be reverted alone. When commits are curated, a merge commit or a rebase keeps them. With squash, the pull request title deserves the care of a commit message.

Some files never belong in history. Secrets first: the Starter ignores `.env` files and `*.pfx` certificates, and tracks only a documented `.env.example`. Once a secret is pushed, a new commit does not remove it from history or from any clone, so rotate it first. Build output, `bin/`, `obj/`, `node_modules/`, only makes diffs noisy.

Generated is not always excluded, though. The Starter commits its EF Core migrations and its published OpenAPI spec, because they are read in review: a migration diff is exactly where a reviewer wants to look.

On a solo prototype or a branch that will be squashed, `wip` commits are fine. What stays useful at any size is a specific subject, and a body for the commit someone will find through `git blame`.


## References
- [git-commit](https://git-scm.com/docs/git-commit) — Git documentation: `--fixup` and the discussion of commit messages.
- [Conventional Commits 1.0.0](https://www.conventionalcommits.org/en/v1.0.0/) — the specification for typed commit subjects.
- [About merge methods on GitHub](https://docs.github.com/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/about-merge-methods-on-github) — GitHub Docs: merge, squash and rebase.
- [Triggering a workflow from a workflow](https://docs.github.com/actions/using-workflows/triggering-a-workflow#triggering-a-workflow-from-a-workflow) — GitHub Docs: why a `GITHUB_TOKEN` label starts no workflow.
