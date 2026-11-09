---
templateKey: 'blog-post'
title: 'Keeping a 105-project .NET solution consistent with Central Package Management'
date: 2027-01-28T09:00:00.000Z
author: Jimmy Boinembalome
authorimage: /img/jimmy.jpg
category: C#
topic: 'Tooling'
illustration: 1
categorycolor: bg-purple-100 text-purple-800
featuredpost: true
description: >-
  Learn how Directory.Packages.props, Directory.Build.props and global.json keep package versions, compiler settings and the SDK identical across every project of a large .NET solution.
tags:
  - Development
  - C#
  - .NET
  - Architecture
---

A [hexagonal architecture](/blog/2026-05-04-hexagonal-architecture-in-dotnet/) multiplies projects: one per domain, one per adapter, one per port, and a test project for most of them. The back end of [Blouppy Starter](https://starter.blouppy.com/) has **105 `.csproj` files**, 39 of them test projects. Without help, each one carries its own `<TargetFramework>`, its own `<Nullable>` and its own `Version="..."` on every package. After a few months, two test projects run two versions of xUnit, and a package bump is a pull request touching forty files.

Three files at the root of the solution fix that: `Directory.Packages.props` for package versions, `Directory.Build.props` for compiler settings, and `global.json` for the SDK.


## One version per package
[Central Package Management](https://learn.microsoft.com/nuget/consume-packages/central-package-management) (CPM) splits a package reference in two. The **version** is declared once, in `Directory.Packages.props`. The **reference** stays in the project, without a version:

```xml
<!-- Directory.Packages.props, at the root -->
<Project>
  <PropertyGroup>
    <ManagePackageVersionsCentrally>true</ManagePackageVersionsCentrally>
  </PropertyGroup>
  <ItemGroup>
    <PackageVersion Include="FluentValidation" Version="12.0.0" />
    <PackageVersion Include="xunit.v3" Version="4.0.2" />
  </ItemGroup>
</Project>

<!-- Any project of the solution -->
<ItemGroup>
  <PackageReference Include="FluentValidation" />
</ItemGroup>
```

NuGet looks for `Directory.Packages.props` in the project's folder, then in each parent, and stops at the first one. A `PackageVersion` is only a declaration: a project that does not reference the package does not get it. A bump is now one line, and every project that uses the package moves at once.

The build enforces it. A `Version` left in a `.csproj` fails restore with `NU1008`, which surprises whoever copies a snippet from a package's page. A reference with no `PackageVersion` fails with `NU1010`, so adding a package means editing two files.

There are escape hatches. `VersionOverride` lets one project use another version, for a migration for instance. `GlobalPackageReference` adds a development-only package, such as an analyzer, to every project. And `CentralPackageTransitivePinningEnabled` lets a `PackageVersion` raise a package that only arrives transitively, which is handy when a vulnerability is published for it. Each one is a small exception to "one version, declared once", so keep them rare.


## Settings every project shares
CPM handles versions. The settings every project repeats belong in [`Directory.Build.props`](https://learn.microsoft.com/visualstudio/msbuild/customize-by-directory), which MSBuild imports into every project below it. In the Starter, `back/Directory.Build.props` is four properties, and that is the whole file: `TargetFramework` `net10.0`, `TreatWarningsAsErrors`, `ImplicitUsings` and `Nullable`.

`TreatWarningsAsErrors` is the important one. A nullable warning nobody reads is a `NullReferenceException` waiting in production. As an error, it cannot be merged. A project with a reason to differ appends to the default rather than replacing it, like `<NoWarn>$(NoWarn);AV0029</NoWarn>`, with a comment saying why.

We leave `LangVersion` out on purpose. The compiler picks it from the target framework, so `net10.0` means C# 14.

There is a trap in the import order. `Directory.Build.props` is imported **before** the content of the `.csproj`, and `Directory.Build.targets` **after** it. A test project declares `<IsTestProject>true</IsTestProject>` in its own file, so a condition on it only works in the `.targets` file:

```xml
<!-- Directory.Build.targets -->
<Project>
  <ItemGroup Condition="'$(IsTestProject)' == 'true'">
    <PackageReference Include="FluentAssertions" />
    <PackageReference Include="xunit.v3" />
  </ItemGroup>
</Project>
```

In `Directory.Build.props`, the same condition is always false: the property is not set yet.

The Starter does not use this trick. Its 39 test projects each list their own references, without versions. The lines repeat, but each project says what it uses, and an integration test project adds `Testcontainers.PostgreSql` without a second condition. The versions are central either way.


## The SDK, and the test runner
[`global.json`](https://learn.microsoft.com/dotnet/core/tools/global-json) selects the .NET SDK for any `dotnet` command run in its folder or below. The Starter's:

```json
{
  "sdk": {
    "version": "10.0.100",
    "rollForward": "latestFeature"
  },
  "test": {
    "runner": "Microsoft.Testing.Platform"
  }
}
```

`10.0.100` is a floor. `latestFeature` accepts any installed 10.0 SDK at or above it, so a developer on a newer feature band builds without installing another SDK. The `test` section, new with the .NET 10 SDK, switches `dotnet test` to [Microsoft.Testing.Platform](https://learn.microsoft.com/dotnet/core/testing/microsoft-testing-platform-intro). That is what makes `dotnet test --project ... --filter-class ...` work.


## What else the central file holds
The Starter's `Directory.Packages.props` declares 91 versions, grouped with `Label` attributes (`.NET`, `Aspire`, `Testing`) so the file reads like a table of contents.

It also lists every accepted risk. Since .NET 10, the [NuGet audit](https://learn.microsoft.com/nuget/concepts/auditing-packages) checks transitive packages by default. With `TreatWarningsAsErrors`, an advisory fails the build. When it concerns a transitive package that cannot be upgraded yet, a `NuGetAuditSuppress` item silences it, next to a comment naming the package and what we are waiting for.

Versions stay exact. A floating `10.0.*` means two restores on two days can give two builds, and NuGet refuses one in a central file by default. A bot such as [Renovate](https://docs.renovatebot.com/modules/manager/nuget/) reads `Directory.Packages.props`, so one pull request edits one line and updates every project.

Keep in mind that the nearest file wins and stops the search. The end-to-end suite lives in `e2e/`, outside `back/`, so it has its own three files and mirrors the versions it shares with the back end.

For a single-project API, CPM is a second file to open for no gain. `global.json` is different: even a one-project repository benefits from it as soon as a developer or the CI has several SDKs installed.


## References
- [Central Package Management (Microsoft Learn)](https://learn.microsoft.com/nuget/consume-packages/central-package-management) — `Directory.Packages.props`, `VersionOverride`, `GlobalPackageReference` and transitive pinning.
- [Customize your build by folder (Microsoft Learn)](https://learn.microsoft.com/visualstudio/msbuild/customize-by-directory) — `Directory.Build.props`, `Directory.Build.targets` and the import order.
- [global.json overview (Microsoft Learn)](https://learn.microsoft.com/dotnet/core/tools/global-json) — SDK selection and `rollForward` policies.
- [Auditing package dependencies (Microsoft Learn)](https://learn.microsoft.com/nuget/concepts/auditing-packages) — NuGet audit and `NuGetAuditSuppress`.
