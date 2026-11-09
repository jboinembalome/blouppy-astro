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

A repository with a .NET solution and four Angular apps has a lot of dependencies: about a hundred NuGet packages in `Directory.Packages.props`, and several hundred npm packages behind one lockfile. Left alone, they drift. Six months later, the upgrade is a week of work, and the one package with a security fix is buried in it.

A dependency bot only helps if most of its pull requests can be merged without thinking about each one. [Renovate](https://docs.renovatebot.com/) gets there with one configuration file for both stacks. The examples below are from the `renovate.json` of [Blouppy Starter](https://starter.blouppy.com/).


## Nights, weekends and patches on their own
Renovate starts from presets. `config:recommended` groups the packages of known monorepos, enables the dependency dashboard and sets sensible defaults. Renovate finds the package files itself: its `nuget` manager reads `Directory.Packages.props`, so [Central Package Management](https://learn.microsoft.com/nuget/consume-packages/central-package-management) needs nothing special, and its `npm` manager updates the one lockfile at the workspace root. The top of the Starter's file:

```json
{
  "extends": ["config:recommended"],
  "schedule": ["after 9pm every weekday", "before 9am every weekday", "every weekend"],
  "timezone": "Europe/Paris",
  "dependencyDashboard": true,
  "major": { "automerge": false },
  "minor": { "automerge": false },
  "patch": { "automerge": true }
}
```

The schedule keeps Renovate to nights and weekends, in the team's time zone. Pull requests wait in the morning instead of arriving during the day, and their CI runs when nobody else needs a runner.

Only patches are automerged, and Renovate merges a branch only after its status checks pass. So the rule really means "a patch that builds and passes its tests". That is only true if the CI really runs on Renovate's branches. If a path filter skips the job that matters, a green status means nothing, so check that a NuGet pull request actually builds and tests the back end before turning automerge on.

The dependency dashboard is one issue in the repository listing every pending update, and why it is pending. It is the one page that answers "how far behind are we?". Further rules label each pull request by stack, `back` or `front`, with the labels the human pull requests use.


## Packages that ship together
`@angular/core` and `@angular/router` release on one version. Updating them one by one gives pull requests that cannot build on their own. Groups fix that:

```json
{
  "matchManagers": ["nuget"],
  "matchPackageNames": ["/^WolverineFx(\\..+)?$/"],
  "groupName": "Wolverine"
},
{
  "extends": ["monorepo:angular", "monorepo:angular-cli"],
  "matchSourceUrls": ["https://github.com/angular/components"],
  "matchPackageNames": ["!zone.js"],
  "groupName": "Angular monorepo"
}
```

[Wolverine](/blog/2026-06-09-replacing-masstransit-with-wolverine/) publishes its packages on one version, often several times a week, so one pull request moves them all. The Angular rule reuses Renovate's own presets, adds the CDK's repository, and leaves `zone.js` out: the app runs zoneless, and `zone.js` has its own release cycle (simplified: the real rule also takes angular-eslint).

A group has a cost: when it fails, any package in it may be the cause. Keep groups to packages that really release together.


## Versions we refuse
Some updates must never be proposed. `allowedVersions` sets a ceiling, and `enabled: false` turns a dependency off:

```json
{
  "matchPackageNames": ["/^FluentAssertions(\\..+)?$/"],
  "allowedVersions": "<8.0.0",
  "description": "FluentAssertions 8 is commercial; 7.x is Apache 2.0."
},
{
  "matchDepNames": ["dotnet-sdk"],
  "enabled": false,
  "description": "back/global.json holds the lowest SDK the solution builds with (10.0.100); rollForward: latestFeature takes any newer one."
}
```

Renovate still proposes every 7.x release of FluentAssertions, but never 8. The same mechanism holds back Vitest and TypeScript while Angular's build package does not accept their next major.

The SDK in `global.json` is a floor, not a pin. With `"rollForward": "latestFeature"`, any newer 10.0 SDK builds the solution, and the 10.0.100 floor is what lets someone build with the SDK their Linux distribution ships. A bot that raised it on every release would lock those people out.

Every rule carries a `description`. Renovate ignores the field. It is there for whoever reads the file next, because a cap without a reason stays forever: nobody dares to remove it. And a cap is not a security policy. A vulnerability fixed only in the next major will not be proposed.

Angular majors are not disabled, but they are never automerged. `ng update` runs the migrations that come with a major, and a version bump in `package.json` does not. So Renovate's pull request is the reminder, and the upgrade itself is done with `ng update` on its own branch.


## Renovate or Dependabot
[Dependabot](https://docs.github.com/code-security/dependabot) is built into GitHub, and it covers more than it used to. It supports NuGet and npm, groups updates with `groups` in `dependabot.yml`, and holds versions back with `ignore`. It needs no app to install, and its security updates come straight from GitHub's advisory database.

What led the Starter to Renovate: automerge is built in, where Dependabot needs a workflow of our own around `dependabot/fetch-metadata`. The dashboard has no Dependabot equivalent. Rules can match on a file path, a source repository or an update type, not only a name. And one file covers every stack.

Renovate has costs too. It is one more GitHub app with write access. Its configuration surface is large, and when two `packageRules` set the same option, the later one wins, which can silently change what a rule does.

For a small repository with one stack and no automerge, Dependabot is enough: it is already there. Renovate pays off with several stacks, packages that must move together, and versions held back for a written reason. If the CI is not trusted yet, fix that first: automerge on an unreliable build only merges breakage faster.


## References
- [Renovate configuration options](https://docs.renovatebot.com/configuration-options/) — `packageRules`, `allowedVersions`, `schedule`, `automerge` and `dependencyDashboard`.
- [Renovate: NuGet](https://docs.renovatebot.com/modules/manager/nuget/) — the manager that reads project files, `Directory.Packages.props` and `global.json`.
- [Dependabot options reference](https://docs.github.com/code-security/dependabot/working-with-dependabot/dependabot-options-reference) — `groups`, `ignore` and `schedule` in `dependabot.yml`.
- [global.json overview](https://learn.microsoft.com/dotnet/core/tools/global-json) — `version` and `rollForward` for the SDK.
