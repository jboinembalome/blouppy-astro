---
templateKey: 'blog-post'
title: 'GitHub Actions for a .NET and Angular repository: path filters, labels and caches'
date: 2026-07-24T09:00:00.000Z
author: Jimmy Boinembalome
authorimage: /img/jimmy.jpg
category: C#
topic: 'Tooling'
illustration: 2
categorycolor: bg-purple-100 text-purple-800
featuredpost: true
description: >-
  Run only the CI jobs a change touches in a .NET and Angular repository, keep one required check that never blocks, trigger slow suites by label and cache NuGet and npm.
tags:
  - Development
  - GitHub
  - GitHub Actions
  - CI
---

A repository that holds an ASP.NET Core back end and several Angular apps has a CI problem as soon as it grows. The .NET solution takes minutes to build and test, and each Angular app has its own lint, tests and build. A typo fixed in the documentation site should not wait for the API's integration tests. Running less is easy to get wrong, though: a required check that never starts blocks the pull request forever.


## The trap of one workflow per app
The obvious layout gives each app its own workflow with a `paths` filter on its trigger. GitHub does the filtering, and it is simple. The trap comes with branch protection. A workflow filtered out by `paths` does not run at all, so its check never reports. If that check is required, the pull request shows "Expected — Waiting for status to be reported" and cannot be merged.

The other layout is one workflow whose first job decides what changed, and whose other jobs run or skip on its answer. A job skipped by its `if` condition does report a status, and GitHub counts a skipped job as passing a required check.


## Detecting what changed
[dorny/paths-filter](https://github.com/dorny/paths-filter) turns a list of globs into one output per filter, `'true'` or `'false'`:

```yaml
jobs:
  changes:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: read
    outputs:
      back: ${{ steps.filter.outputs.back }}
      front: ${{ steps.filter.outputs.front }}
    steps:
      - uses: dorny/paths-filter@v4
        id: filter
        with:
          filters: |
            back:
              - 'back/**'
              - '.github/workflows/build.yml'
            front:
              - 'front/application/**'
              - 'front/package-lock.json'
              - '.github/workflows/build.yml'

  back:
    needs: changes
    if: needs.changes.outputs.back == 'true'
    runs-on: ubuntu-latest
    steps:
      - run: echo "building the back end"
```

On a pull request, `pull-requests: read` lets the action list the changed files through the API, with no checkout. On a push, it diffs two commits, so it needs a checkout with history.

The filters must follow real dependencies. In [Blouppy Starter](https://starter.blouppy.com/), the `changes` job has six filters. The identity host compiles the design tokens of `front/libs/ui` into its stylesheet, so a token change runs the back end too. Every app depends on the shared lockfile. And the workflow file is in every filter, so a change to the pipeline is validated against every part. These globs drift: a new dependency between two parts must be added by hand, or a job that should run is skipped and the pull request is green for the wrong reason.


## One required check that never waits
Skipped jobs pass, which opens a quieter hole. If the `changes` job fails, every job that `needs` it is skipped, and skipped counts as passing. Requiring each job by name would also mean editing branch protection for every new job.

The Starter requires one check, `CI`, from a final job that depends on all the others:

```yaml
  ci:
    name: CI
    if: always()
    needs: [ changes, ui, playground, front, landing, docs, back ]
    runs-on: ubuntu-latest
    steps:
      - name: Verify that no job failed ✅
        if: contains(needs.*.result, 'failure') || contains(needs.*.result, 'cancelled')
        run: |
          echo "::error::A required job failed or was cancelled."
          exit 1
```

`if: always()` makes it run whatever happened upstream. `needs.*.result` holds `success`, `failure`, `cancelled` or `skipped` for each dependency, and the step fails on the first two. A skipped job is fine; a failed `changes` job is not. The one rule to remember: a new job goes in that `needs` list, or its failure never reaches the required check.


## Caches and cancelled runs
`actions/setup-dotnet` has a `cache` input, but it keys on `packages.lock.json` files, and the Starter has none. It uses `actions/cache` directly:

```yaml
- name: Cache NuGet packages 📦
  uses: actions/cache@v6
  with:
    path: ~/.nuget/packages
    key: ${{ runner.os }}-nuget-${{ hashFiles('back/Directory.Packages.props', 'back/**/*.csproj') }}
    restore-keys: |
      ${{ runner.os }}-nuget-
```

The `restore-keys` prefix restores the closest older cache when a version changed, so only the new packages are downloaded. On the npm side, the four Angular apps are one npm workspace with one lockfile, and `setup-node` caches npm's downloads with `cache: npm` and `cache-dependency-path: front/package-lock.json`.

A run can read caches from its own branch and from the default branch, never from another pull request's branch. That is why the workflow also runs on pushes to `main`: the caches saved there are the ones every pull request can restore.

Three pushes in a row to a pull request start three runs, and only the last matters. A concurrency group keyed on `github.event.pull_request.number || github.ref` cancels the others. `cancel-in-progress` is only true for pull requests, so every commit of `main` still gets a complete run.


## A slow suite behind a label
The Starter's end-to-end suite boots the whole graph through Aspire: PostgreSQL, RabbitMQ, the identity host, the API and the gateway. Most pull requests never touch what only that suite can see. So `e2e.yml` runs on a version tag, by hand, and on a pull request that carries the `e2e 🧪` label:

```yaml
on:
  pull_request:
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

`labeled` starts the run when the label is added, and `synchronize` reruns it on each push while it stays on. The second half of the condition stops other labels from starting it again. This workflow is not a required check: as one, it would block every pull request without the label.

[actions/labeler](https://github.com/actions/labeler) adds labels from the changed paths, and it can add `e2e 🧪` to a change under `e2e/`. There is a catch. Events caused by the `GITHUB_TOKEN` start no new workflow run, so that label does not fire `e2e.yml` at once. The suite first runs on the next push, when `synchronize` finds the label there. A person adding the label by hand starts it immediately.


## When not to bother
For a repository with one app, or a CI that takes two minutes, none of this is worth it. One workflow that runs everything, with the setup actions' cache inputs and a concurrency group, has no filter to keep in sync. Path filtering earns its place when a part takes long enough that people wait for it on changes that cannot affect it.


## References
- [Troubleshooting required status checks](https://docs.github.com/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/troubleshooting-required-status-checks) — GitHub Docs: why a check skipped by path filtering stays pending.
- [Caching dependencies to speed up workflows](https://docs.github.com/actions/writing-workflows/choosing-what-your-workflow-does/caching-dependencies-to-speed-up-workflows) — GitHub Docs: keys, `restore-keys` and which branches a run reads from.
- [Triggering a workflow from a workflow](https://docs.github.com/actions/writing-workflows/choosing-when-your-workflow-runs/triggering-a-workflow#triggering-a-workflow-from-a-workflow) — GitHub Docs: why an event caused by `GITHUB_TOKEN` starts no workflow.
- [dorny/paths-filter](https://github.com/dorny/paths-filter) — the changed-paths detection action.
