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

A repository that holds an ASP.NET Core back end and several Angular apps has a CI problem as soon as it grows. The .NET solution takes minutes to build and test, each Angular app has its own lint, tests and build, and a typo fixed in the documentation site should not wait for the integration tests of the API. Running everything on every pull request is slow and expensive. Running less is easy to get wrong: a required check that never starts blocks the pull request forever.

In this article, we will build a CI for such a repository with GitHub Actions: one workflow with a job per part, a step that detects what changed, a single required check, a slow suite started by a label, NuGet and npm caches, concurrency groups, a labeler and a pull request template. The real example is the CI of [Blouppy Starter](https://starter.blouppy.com/).


## One workflow or one per app
There are two common layouts. The first gives each app its own workflow file, with a `paths` filter on its trigger:

```yaml
name: Front
on:
  pull_request:
    paths: [ 'front/application/**' ]
```

It is simple, and GitHub does the filtering. The trap comes with branch protection. When a workflow is filtered out by `paths`, it does not run at all, so its check never reports. If that check is required, the pull request waits on it with "Expected — Waiting for status to be reported" and cannot be merged.

The second layout is one workflow whose first job decides what changed, and whose other jobs run or skip on its answer. A job skipped by its `if` condition does report a status, and GitHub counts a skipped job as passing a required check. This is the layout the Starter uses.


## Detecting what changed
[dorny/paths-filter](https://github.com/dorny/paths-filter) turns a list of globs into one output per filter, `'true'` or `'false'`. A minimal version:

```yaml
jobs:
  changes:
    runs-on: ubuntu-latest
    outputs:
      back: ${{ steps.filter.outputs.back }}
    steps:
      - uses: dorny/paths-filter@v4
        id: filter
        with:
          filters: |
            back:
              - 'back/**'

  back:
    needs: changes
    if: needs.changes.outputs.back == 'true'
    runs-on: ubuntu-latest
    steps:
      - run: echo "building the back end"
```

In the Starter, `build.yml` runs on pull requests and on pushes to `main`, and the `changes` job declares six filters: `back`, `front`, `landing`, `playground`, `ui` and `docs`. Trimmed to two of them:

```yaml
  changes:
    runs-on: ubuntu-latest
    permissions:
      # A job-level block replaces the workflow-level one instead of merging
      # with it, so contents has to be repeated for the checkout below.
      contents: read
      pull-requests: read
    outputs:
      back: ${{ steps.filter.outputs.back }}
      front: ${{ steps.filter.outputs.front }}
    steps:
      # On pull_request the filter reads the changed-file list from the API and
      # needs no checkout; on push it diffs two commits, so it needs the history.
      - uses: actions/checkout@v7
        name: Checkout code
        if: github.event_name != 'pull_request'
        with:
          fetch-depth: 0

      - name: Detect changed paths 🔍
        uses: dorny/paths-filter@v4
        id: filter
        with:
          filters: |
            back:
              - 'back/**'
              - 'api/**'
              - 'front/libs/ui/src/tokens/**'
              - '.github/workflows/build.yml'
            front:
              - 'front/application/**'
              - 'front/package.json'
              - 'front/package-lock.json'
              - 'front/libs/**'
              - '.github/workflows/build.yml'
```

Three details carry most of the value. The filters follow real dependencies: the identity host compiles the design tokens of `front/libs/ui` into its stylesheet, so a token change runs the back end too, and every app depends on the shared lockfile and on `front/libs/`. The workflow file is in every filter, so a change to the pipeline itself is validated against every part. And the `pull-requests: read` permission is what lets the action list the changed files through the API without a checkout.


## One required check that never waits
Skipped jobs pass, which solves the blocked pull request but opens a quieter hole. If the `changes` job fails, every job that `needs` it is skipped, and skipped counts as passing. Requiring each job by name would also mean editing branch protection every time a job is added.

The Starter requires one check, `CI`, from a final job that depends on all the others:

```yaml
  # Single required status check: it always runs, even when every build job is
  # skipped, so branch protection never waits on a job that will not start.
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

`if: always()` makes it run whatever happened upstream. `needs.*.result` holds `success`, `failure`, `cancelled` or `skipped` for each dependency, and the step fails on the first two. A skipped job is fine, a failed `changes` job is not. The one rule to remember: a new job must be added to that `needs` list, otherwise its failure does not reach the required check.


## Caching NuGet and npm
`actions/setup-dotnet` has a `cache` input, but it keys the cache on `packages.lock.json` files, and the Starter has none. It uses `actions/cache` directly, with a key built from the central version file and every project file:

```yaml
      - name: Setup .NET 📦
        uses: actions/setup-dotnet@v6
        with:
          dotnet-version: '10.x.x'

      # No packages.lock.json in the solution, so the key is derived from the
      # central version file plus every project file.
      - name: Cache NuGet packages 📦
        uses: actions/cache@v6
        with:
          path: ~/.nuget/packages
          key: ${{ runner.os }}-nuget-${{ hashFiles('back/Directory.Packages.props', 'back/**/*.csproj') }}
          restore-keys: |
            ${{ runner.os }}-nuget-
```

The `restore-keys` prefix lets a run restore the closest older cache when a version changed, so only the new packages are downloaded.

On the npm side, the four Angular apps are one npm workspace rooted at `front/`, with a single lockfile. Every front-end job calls the same composite action, `.github/actions/setup-node-project`, which lets `setup-node` cache npm's download cache, keyed on that lockfile:

```yaml
    - name: Setup Node 📦
      uses: actions/setup-node@v7
      with:
        node-version: ${{ inputs.node-version }}
        cache: npm
        cache-dependency-path: front/package-lock.json

    - name: Pin npm 📌
      shell: bash
      run: npm install --global npm@${{ inputs.npm-version }}

    - name: Install dependencies 📂
      shell: bash
      working-directory: front
      run: npm ci
```

The pin is there because the lockfile is regenerated by Renovate with a newer npm major than the one Node 22 bundles, and the older npm rejects that lockfile. The real action also prints an error that names this cause when `npm ci` fails, which saves the next person an hour.

One more rule decides whether a cache pays off. A workflow run can read caches created on its own branch and on the default branch, not on another pull request's branch. That is why `build.yml` also runs on pushes to `main`: the caches saved there are the ones every pull request can restore.


## Cancelling superseded runs
Pushing three commits in a row to a pull request starts three runs, and only the last one matters. A concurrency group cancels the others:

```yaml
# A new push to a pull request makes the run in flight obsolete.
concurrency:
  group: ${{ github.workflow }}-${{ github.event.pull_request.number || github.ref }}
  cancel-in-progress: ${{ github.event_name == 'pull_request' }}
```

The group is the pull request number, or the ref for a push. `cancel-in-progress` is only true for pull requests, so a run on `main` queues behind the previous one rather than cancelling it, and every commit of `main` gets a complete run.


## A slow suite behind a label
The Starter has an end-to-end suite that boots the whole graph through Aspire: PostgreSQL, RabbitMQ, the identity host, the API and the gateway. Most pull requests never touch what only that suite can see, so `e2e.yml` runs on a version tag, by hand, and on a pull request that carries the `e2e 🧪` label:

```yaml
on:
  pull_request:
    branches: [ main ]
    types: [ opened, reopened, synchronize, labeled ]
  push:
    tags: [ 'v*' ]
  workflow_dispatch:

jobs:
  e2e:
    name: End-to-end
    if: >-
      github.event_name != 'pull_request'
      || (contains(github.event.pull_request.labels.*.name, 'e2e 🧪')
          && (github.event.action != 'labeled' || github.event.label.name == 'e2e 🧪'))
    runs-on: ubuntu-latest
    timeout-minutes: 30
```

`labeled` in the event types starts the run when the label is added, and `synchronize` reruns it on each push while it stays on. The second half of the condition stops other labels from starting it: adding `documentation 📄` to a labelled pull request would otherwise run the suite again.

Labels also interact with concurrency. The labeler adds several labels when a pull request opens, each one a `labeled` event in the same group, and each would cancel the run before it. So a label other than `e2e 🧪` gets a group of its own, built from the run id:

```yaml
concurrency:
  group: >-
    ${{ github.workflow }}-${{ github.event.pull_request.number || github.ref }}${{
    github.event.action == 'labeled' && github.event.label.name != 'e2e 🧪'
    && format('-{0}', github.run_id) || '' }}
  cancel-in-progress: ${{ github.event_name == 'pull_request' }}
```

This workflow is not a required check: as one, it would block every pull request without the label.


## A labeler and a pull request template
[actions/labeler](https://github.com/actions/labeler) adds labels from the paths a pull request changes. The workflow is short:

```yaml
name: labeler
on:
- pull_request_target

jobs:
  label:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: write
    steps:
    - name: Run Labeler
      uses: actions/labeler@v7
      with:
        repo-token: "${{ secrets.GITHUB_TOKEN }}"
```

`pull_request_target` runs in the context of the base branch with a token that can write labels, including for pull requests from forks. That is safe here because the job never checks out the pull request's code. The rules live in `.github/labeler.yml`:

```yaml
back ⚙️:
- changed-files:
  - any-glob-to-any-file: back/**

migration 📦:
- changed-files:
  - any-glob-to-any-file: back/Blouppy.Infrastructure.Database/Migrations/*

e2e 🧪:
- changed-files:
  - any-glob-to-any-file: e2e/**
  - any-glob-to-any-file: .github/workflows/e2e.yml
```

The `e2e 🧪` rule has a catch. Events triggered with the `GITHUB_TOKEN` start no new workflow run, so the label the labeler adds does not fire `e2e.yml`. The suite first runs on the next push, when `synchronize` finds the label already there. A person adding it by hand starts it at once.

The pull request template, `.github/pull_request_template.md`, asks for a description, the motivation and impact, which kinds of tests were run (unit, integration, end-to-end, as checkboxes) and related links. The end-to-end checkbox is a reminder that the label exists.


## What it costs and when not to bother
- **Filters drift.** A new dependency between two parts, such as the tokens read by the identity host, must be added by hand. A missing glob skips a job that should have run, and the pull request is green for the wrong reason.
- **The aggregate job must list every job.** Forget one in `needs` and its failure no longer reaches `CI`.
- **Main runs every commit.** Its runs are never cancelled, which costs minutes, and they are what builds the caches.
- **Labels are a convention.** Nothing forces anyone to add `e2e 🧪` to a change that crosses the graph. The tag trigger is the safety net before a release.

For a repository with one app, or a CI that takes two minutes, none of this is worth it. One workflow that runs everything, with `setup-node`'s and `setup-dotnet`'s cache inputs and a concurrency group, is enough, and it has no filter to keep in sync. Path filtering earns its place when a part takes long enough that people start to wait for it on changes that cannot affect it.


## Conclusion
A monorepo CI does not need one workflow per app. A first job detects what changed with `dorny/paths-filter`, the other jobs skip on its answer, and a final `CI` job with `if: always()` is the only required check, failing on any failed or cancelled dependency. Caches keyed on the right files, a concurrency group that cancels only pull request runs, and a label for the slow suite do the rest. Like the [architecture tests that fail the build](/blog/2026-07-03-architecture-tests-that-fail-the-build/) and the [repository tests on Testcontainers](/blog/2026-07-15-testing-ef-core-repositories-with-testcontainers/), all of this runs in the CI of [Blouppy Starter](https://starter.blouppy.com/).

## References
- [Workflow syntax for GitHub Actions (GitHub Docs)](https://docs.github.com/actions/writing-workflows/workflow-syntax-for-github-actions) — `on.<event>.paths`, `jobs.<job_id>.if`, `needs` and `concurrency`.
- [Troubleshooting required status checks (GitHub Docs)](https://docs.github.com/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/troubleshooting-required-status-checks) — why a check skipped by path filtering stays pending, and how skipped jobs report.
- [Caching dependencies to speed up workflows (GitHub Docs)](https://docs.github.com/actions/writing-workflows/choosing-what-your-workflow-does/caching-dependencies-to-speed-up-workflows) — cache keys, `restore-keys` and which branches a run can read caches from.
- [Triggering a workflow from a workflow (GitHub Docs)](https://docs.github.com/actions/writing-workflows/choosing-when-your-workflow-runs/triggering-a-workflow#triggering-a-workflow-from-a-workflow) — why an event caused by `GITHUB_TOKEN` starts no workflow.
- [dorny/paths-filter (GitHub)](https://github.com/dorny/paths-filter) — the changed-paths detection action.
- [actions/labeler (GitHub)](https://github.com/actions/labeler) — labels from changed paths, and the `changed-files` configuration.
- [actions/setup-node (GitHub)](https://github.com/actions/setup-node) — the `cache` and `cache-dependency-path` inputs.
- [actions/setup-dotnet (GitHub)](https://github.com/actions/setup-dotnet) — the .NET SDK setup and its `cache` input.
- [Creating a pull request template (GitHub Docs)](https://docs.github.com/communities/using-templates-to-encourage-useful-issues-and-pull-requests/creating-a-pull-request-template-for-your-repository) — where the template file goes.
