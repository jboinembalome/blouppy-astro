---
templateKey: 'blog-post'
title: 'Renovate for a .NET and Angular monorepo'
date: 2027-03-11T09:00:00.000Z
author: Jimmy Boinembalome
authorimage: /img/jimmy.jpg
category: C#
topic: 'Tooling'
illustration: 1
categorycolor: bg-purple-100 text-purple-800
featuredpost: true
description: >-
  Keep a .NET and Angular monorepo current with Renovate: groups, schedules, patch automerge behind green CI, version caps for licences, and what to leave manual.
tags:
  - Development
  - .NET
  - Angular
---

A repository with a .NET solution and four Angular apps has a lot of dependencies: about a hundred NuGet packages in `Directory.Packages.props`, and several hundred npm packages behind one lockfile. Left alone, they drift. Six months later, the upgrade is a week of work, and the one package that had a security fix is buried in it. Updating by hand every Monday works for a while, then stops.

In this article, we will keep such a monorepo current with [Renovate](https://docs.renovatebot.com/): one configuration for both stacks, packages that release together grouped into one pull request, a schedule, patch updates merged on their own once CI is green, caps for the versions we must not take, and the updates we keep manual. We will also compare it honestly with Dependabot, which is the simpler choice for many repositories.


## What a dependency bot has to do
Opening a pull request per outdated package is the easy part. In a monorepo, the hard parts are elsewhere:

- **Packages that ship together.** `@angular/core`, `@angular/router` and `@angular/build` are released on one version. Updating them one by one gives pull requests that cannot build on their own.
- **Two stacks, one CI.** A NuGet update should build the back end, an npm update the front end, and a reviewer should see at a glance which is which.
- **Versions we refuse.** A library that changes its licence in a new major should never be proposed again, and a library whose peers do not accept the next major yet should wait.
- **Noise.** Twenty pull requests on a Tuesday morning compete with real work. Most of them are patches that nobody will read.

Renovate answers each of these with configuration. The whole file lives at the root of the repository, in `renovate.json`.


## A minimal configuration
Renovate starts from presets. `config:recommended` is the one its documentation suggests: it groups the packages of known monorepos, enables the dependency dashboard and sets sensible defaults. A first configuration for a .NET and Angular repository can be this short:

```json
{
  "$schema": "https://docs.renovatebot.com/renovate-schema.json",
  "extends": ["config:recommended"],
  "schedule": ["every weekend"],
  "timezone": "Europe/Paris",
  "patch": {
    "automerge": true
  }
}
```

Renovate finds the package files itself. Its `nuget` manager reads project files and `Directory.Packages.props`, so [Central Package Management](https://learn.microsoft.com/nuget/consume-packages/central-package-management) needs nothing special: the version is changed in the one place it is declared. Its `npm` manager reads every `package.json`, and in an npm workspace it updates the lockfile at the workspace root. It also reads `global.json`, where the SDK version appears as the dependency `dotnet-sdk`.


## The real example
[Blouppy Starter](https://starter.blouppy.com/) has the layout described above: `back/` for the .NET solution, `e2e/` for the end-to-end suite, and `front/` as an npm workspace whose root holds the one `package-lock.json` for the application, the landing page, the documentation site, the design-system playground and the shared libraries. Its `renovate.json` shows each idea in turn.

### Schedule and automerge
```json
{
  "extends": ["config:recommended"],
  "commitMessagePrefix": "chore(deps):",
  "branchPrefix": "renovate/",
  "additionalBranchPrefix": "{{parentDir}}/",
  "schedule": [
    "after 9pm every weekday",
    "before 9am every weekday",
    "every weekend"
  ],
  "timezone": "Europe/Paris",
  "dependencyDashboard": true,
  "major": { "automerge": false },
  "minor": { "automerge": false },
  "patch": { "automerge": true }
}
```

The schedule keeps Renovate to nights and weekends, in the team's time zone. Pull requests are waiting in the morning instead of arriving during the day, and their CI runs when nobody else is waiting for a runner.

Only patches are automerged. Renovate merges a branch only after the status checks reported on it pass, so the rule really means "a patch that builds and passes its tests". Minor and major updates stay pull requests that a person merges. `additionalBranchPrefix` puts the parent folder of the package file in the branch name, which helps when the same package is updated in several places.

### Labels per stack
```json
{
  "matchManagers": ["nuget"],
  "matchFileNames": ["back/**", "e2e/**"],
  "labels": ["back ⚙️", "dependencies 📦", "nuget"]
},
{
  "matchManagers": ["npm"],
  "matchFileNames": ["front/**"],
  "labels": ["front 👁️", "dependencies 📦", "npm"]
}
```

Two more rules of the same shape label `front/landing/**` and `front/docs/**`. The labels are the ones the human pull requests use, so a reviewer filters dependency updates the same way as everything else. The CI does not need them: its path filter already builds the back end for a change under `back/` and the front end for a change to `front/package-lock.json`.

### Groups
```json
{
  "matchManagers": ["nuget"],
  "matchPackageNames": ["/^WolverineFx(\\..+)?$/"],
  "groupName": "Wolverine",
  "description": "Its packages ship together, near-daily, on one version: one pull request moves them all, so the adapter never mixes two releases."
},
{
  "matchPackageNames": ["/^xunit/"],
  "groupName": "xUnit monorepo"
},
{
  "extends": ["monorepo:angular", "monorepo:angular-cli"],
  "matchSourceUrls": [
    "https://github.com/angular/components",
    "https://github.com/angular-eslint/angular-eslint"
  ],
  "matchPackageNames": ["!zone.js"],
  "groupName": "Angular monorepo"
}
```

[Wolverine](/blog/2026-06-09-replacing-masstransit-with-wolverine/) publishes `WolverineFx`, `WolverineFx.RabbitMQ`, `WolverineFx.Postgresql` and `WolverineFx.EntityFrameworkCore` on one version, often several times a week. The regular expression catches all of them, so one pull request moves the four together. The `description` field is ignored by Renovate itself; it is there for whoever reads the file next.

The Angular rule reuses Renovate's own `monorepo:angular` and `monorepo:angular-cli` presets, adds the CDK's repository and angular-eslint, and leaves `zone.js` out: the app runs zoneless, and `zone.js` has its own release cycle. The other groups follow the same idea: AutoFixture and the `dotnet/extensions` packages by their source repository, the ESLint packages by name.

### Caps
```json
{
  "matchManagers": ["nuget"],
  "matchPackageNames": ["/^FluentAssertions(\\..+)?$/"],
  "allowedVersions": "<8.0.0",
  "description": "FluentAssertions 8 is commercial; 7.x is Apache 2.0."
},
{
  "matchManagers": ["npm"],
  "matchPackageNames": ["vitest", "@vitest/coverage-v8"],
  "allowedVersions": "<5",
  "description": "Angular's build package peers vitest ^4.0.8, so vitest 5 and Angular 22 cannot be installed together. Drop this pin once that changes."
}
```

`allowedVersions` is the ceiling. Renovate still proposes every 7.x release of FluentAssertions, but never 8, whose licence is commercial. The same mechanism holds back TypeScript below 7 while typescript-eslint and Angular's build package do not accept it, and an icon font whose major dropped its licence field. Each cap says why it exists and when to drop it. A cap without a reason stays forever, because nobody dares to remove it.

### What stays manual
```json
{
  "matchDepNames": ["dotnet-sdk"],
  "enabled": false,
  "description": "back/global.json holds the lowest SDK the solution builds with (10.0.100); rollForward: latestFeature takes any newer one."
}
```

The SDK in `global.json` is a floor, not a pin. With `"rollForward": "latestFeature"`, any newer 10.0 SDK builds the solution, and keeping the floor at 10.0.100 is what lets someone build with the SDK their Linux distribution ships. A bot that raises it on every release would lock those people out, so Renovate does not touch it.

Major Angular versions are not disabled, but they are not automerged either, and in practice they are not merged from Renovate's pull request at all. `ng update` runs the migrations that come with a major; a version bump in `package.json` does not. We use Renovate's pull request as the reminder, then do the upgrade with `ng update` on its own branch, and check it with the [visual review](/blog/2026-08-14-visual-review-for-an-angular-app-with-playwright/) as well as the tests.

### The dependency dashboard
`dependencyDashboard: true` makes Renovate keep one issue in the repository with every pending update: open pull requests, updates waiting for the schedule, updates held back by a rule, and the majors it found. A checkbox next to an update asks Renovate to open its pull request now. It is the one page that answers "how far behind are we?".

### One file, or presets
The Starter keeps everything in one `renovate.json`, about two hundred lines. A project-management app built on the Starter, with the same layout, splits the same rules into local presets: one folder per stack under `.github/renovate/`, one small file per rule, and a `renovate.json` that only extends them. Renovate supports both. The single file is easier to read once; the presets make a diff to one rule obvious and let a rule move with its stack.


## Renovate or Dependabot
[Dependabot](https://docs.github.com/code-security/dependabot) is built into GitHub, and it covers more of this than it used to. It supports both NuGet and npm, it can group updates since `groups` was added to `dependabot.yml`, and it can hold versions back with `ignore`:

```yaml
version: 2
updates:
  - package-ecosystem: nuget
    directory: /back
    schedule:
      interval: weekly
    groups:
      wolverine:
        patterns:
          - "WolverineFx*"
    ignore:
      - dependency-name: FluentAssertions
        versions: [">= 8.0.0"]
```

What Dependabot does that Renovate does not do as directly: it needs no app to install, and its security updates come straight from GitHub's advisory database and the repository's security tab.

What led us to Renovate for this repository:

- **Automerge is built in.** With Dependabot, merging patches on green CI takes a workflow of our own that reads the update type (with `dependabot/fetch-metadata`) and enables auto-merge on the pull request.
- **The dependency dashboard.** Dependabot has no equivalent single issue listing what is pending and why.
- **Rules that match on more than a name.** Renovate matches by manager, file path, source repository or update type, and reuses shared presets such as `monorepo:angular`. Grouping every package of the Angular repositories by source is one rule.
- **One configuration for every stack.** Dependabot configures one entry per ecosystem and directory.

The cost is on Renovate's side too. It is one more GitHub app with write access to the repository. Its configuration surface is large, and a wrong `packageRules` order can silently change what a rule does: when two rules set the same option, the later one wins. Its documentation is long, and the presets hide behaviour that we only discover by reading them.


## Pitfalls
- **Automerge needs real checks.** If the CI does not run on Renovate's branches, or runs a path filter that skips the job that matters, a green status means nothing. Check that a NuGet pull request actually builds and tests the back end before turning automerge on.
- **Groups hide the culprit.** When a grouped update fails, any package of the group may be the cause. Keep groups to packages that really release together.
- **Caps rot.** An `allowedVersions` written for a peer-dependency conflict stays after the conflict is gone. Write the condition for removing it next to the cap.
- **A cap is not a security policy.** A capped package still gets patches within its range, but a vulnerability fixed only in the next major will not be proposed.
- **The lockfile drifts too.** Transitive npm dependencies move only when a direct one does. Renovate has a `lockFileMaintenance` option that refreshes the lockfile on a schedule; it is not enabled by `config:recommended`.


## When not to bother
For a small repository with one stack, a handful of dependencies and no automerge, Dependabot is enough. It is already there, its `groups` and `ignore` cover the common cases, and there is nothing to install. Renovate pays off once the repository has several stacks, packages that must move together, versions that must be held back for a written reason, and enough patch releases that reviewing them by hand is wasted time. If the CI is not trusted yet, fix that first: automerge on an unreliable build only merges breakage faster.


## Conclusion
A dependency bot only helps if its pull requests can be merged without thinking about each one. In a .NET and Angular monorepo, that means grouping the packages that ship together, scheduling the updates outside working hours, automerging patches behind a CI that really builds the stack they touch, capping the versions we refuse with the reason written beside the cap, and keeping the SDK floor and Angular majors in our own hands. Renovate expresses all of it in one file; Dependabot covers part of it with less to set up.


## References
- [Renovate documentation](https://docs.renovatebot.com/) — the bot, its managers and how it runs.
- [Renovate configuration options](https://docs.renovatebot.com/configuration-options/) — `packageRules`, `allowedVersions`, `schedule`, `automerge`, `dependencyDashboard` and `lockFileMaintenance`.
- [Renovate: NuGet](https://docs.renovatebot.com/modules/manager/nuget/) — the manager that reads project files, `Directory.Packages.props` and `global.json`.
- [Renovate: config:recommended](https://docs.renovatebot.com/presets-config/#configrecommended) — what the recommended preset turns on.
- [Central Package Management](https://learn.microsoft.com/nuget/consume-packages/central-package-management) — one place for every NuGet version.
- [global.json overview](https://learn.microsoft.com/dotnet/core/tools/global-json) — `version` and `rollForward` for the SDK.
- [Dependabot options reference](https://docs.github.com/code-security/dependabot/working-with-dependabot/dependabot-options-reference) — `groups`, `ignore` and `schedule` in `dependabot.yml`.
- [Automating Dependabot with GitHub Actions](https://docs.github.com/code-security/dependabot/working-with-dependabot/automating-dependabot-with-github-actions) — the `fetch-metadata` workflow for auto-merge.
- [ng update](https://angular.dev/cli/update) — upgrading Angular with its migrations.
