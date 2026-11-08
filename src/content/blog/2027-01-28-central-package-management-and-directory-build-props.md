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

A [hexagonal architecture](/blog/2026-05-04-hexagonal-architecture-in-dotnet/) multiplies projects. One project per domain, one per adapter, one per port, and a test project for most of them: the back end of Blouppy Starter has **105 `.csproj` files**, 39 of them test projects. Without help, each one carries its own `<TargetFramework>`, its own `<Nullable>`, and its own `Version="..."` on every package. After a few months, one test project runs xUnit 3.1 and another 3.2, one project has nullable warnings switched off, and a package bump is a pull request touching forty files.

In this article, we will move all of that into three files at the root of the solution: `Directory.Packages.props` for package versions, `Directory.Build.props` for the compiler settings, and `global.json` for the SDK and the test runner. Then we will look at the pitfalls, and at when a small solution does not need any of it.


## Central Package Management
[Central Package Management](https://learn.microsoft.com/nuget/consume-packages/central-package-management) (CPM) splits a package reference in two. The **version** is declared once, in `Directory.Packages.props`. The **reference** stays in the project, without a version.

A minimal example:

```xml
<!-- Directory.Packages.props -->
<Project>
  <PropertyGroup>
    <ManagePackageVersionsCentrally>true</ManagePackageVersionsCentrally>
  </PropertyGroup>
  <ItemGroup>
    <PackageVersion Include="FluentValidation" Version="12.0.0" />
    <PackageVersion Include="xunit.v3" Version="4.0.2" />
  </ItemGroup>
</Project>
```

```xml
<!-- Any project of the solution -->
<ItemGroup>
  <PackageReference Include="FluentValidation" />
</ItemGroup>
```

NuGet looks for `Directory.Packages.props` in the project's folder, then in each parent folder, and stops at the first one it finds. A `PackageVersion` is only a declaration: a project that does not reference the package does not get it. Bumping a package is now a one-line change, and every project that uses it moves at once.


### Exceptions: VersionOverride and GlobalPackageReference
Two escape hatches exist, and both are useful in small doses.

`VersionOverride` lets one project use another version than the central one:

```xml
<PackageReference Include="Microsoft.OpenApi" VersionOverride="2.1.0" />
```

It is meant for a temporary exception, during a migration for instance. Each one is a place where the solution is no longer consistent, so a team that never wants them can set `CentralPackageVersionOverrideEnabled` to `false`, and an override becomes a build error.

`GlobalPackageReference` goes the other way: declared in `Directory.Packages.props`, it adds the package to **every** project. It is designed for development-only packages such as analyzers or a source-link package, and NuGet adds it as a private asset, so it never flows to the consumers of a project:

```xml
<ItemGroup>
  <GlobalPackageReference Include="Roslynator.Analyzers" Version="4.13.1" />
</ItemGroup>
```

A runtime library has no business being global: the domain models of a hexagon must stay free of external dependencies, and a global reference would give one to every leaf at once.


### Transitive pinning
A central version only applies to the packages a project references directly. A package pulled in **transitively** still gets whatever version its parent asks for. When a vulnerability is published for a transitive dependency, we can pin it:

```xml
<PropertyGroup>
  <CentralPackageTransitivePinningEnabled>true</CentralPackageTransitivePinningEnabled>
</PropertyGroup>
<ItemGroup>
  <PackageVersion Include="System.Text.Json" Version="10.0.2" />
</ItemGroup>
```

With pinning enabled, a `PackageVersion` also raises the version of that package wherever it appears in the graph, without adding a `PackageReference` to each project. The cost: the pinned package becomes a real dependency of the projects that pull it in, and of the NuGet packages we publish from them.


## Directory.Build.props and Directory.Build.targets
CPM handles versions. The other settings every project repeats, the target framework, `Nullable`, `TreatWarningsAsErrors`, belong in [`Directory.Build.props`](https://learn.microsoft.com/visualstudio/msbuild/customize-by-directory). MSBuild imports it automatically, from the nearest parent folder, into every project below it.

The order of imports matters:
- `Directory.Build.props` is imported **early**, before the content of the `.csproj`. A property set there is a default the project can override.
- `Directory.Build.targets` is imported **late**, after the content of the `.csproj`. It can read what the project declared.

That difference decides where a conditional item goes. A test project declares `<IsTestProject>true</IsTestProject>` in its own file, so a condition on `IsTestProject` in `Directory.Build.props` would always be false: the property is not set yet. The same condition works in `Directory.Build.targets`:

```xml
<!-- Directory.Build.targets -->
<Project>
  <ItemGroup Condition="'$(IsTestProject)' == 'true'">
    <PackageReference Include="FluentAssertions" />
    <PackageReference Include="Microsoft.NET.Test.Sdk" />
    <PackageReference Include="xunit.v3" />
  </ItemGroup>
</Project>
```

The references still have no version: CPM resolves them from `Directory.Packages.props`. If the condition must live in `Directory.Build.props`, it can only use what is known that early, such as the project's name: `Condition="$(MSBuildProjectName.EndsWith('Tests'))"`.

`LangVersion` is a setting we usually leave out. The compiler picks the language version from the target framework, so `net10.0` means C# 14. Setting `LangVersion` to `latest` or `preview` decouples the two, which is rarely what we want in an application.


## global.json: the SDK and the test runner
The last file pins what builds the code. [`global.json`](https://learn.microsoft.com/dotnet/core/tools/global-json) selects the .NET SDK for any `dotnet` command run in its folder or below. Since the .NET 10 SDK, it can also choose how `dotnet test` runs: `"test": { "runner": "Microsoft.Testing.Platform" }` switches it from VSTest to [Microsoft.Testing.Platform](https://learn.microsoft.com/dotnet/core/testing/microsoft-testing-platform-intro), which is what makes `dotnet test --project ... --filter-class ...` work, as seen in [Testing EF Core repositories with Testcontainers](/blog/2026-07-15-testing-ef-core-repositories-with-testcontainers/).


## The real example: Blouppy Starter
The back end of [Blouppy Starter](https://starter.blouppy.com/) uses the three files, and they are short.

`back/Directory.Build.props` holds four properties, and that is the whole file:

```xml
<Project>
  <PropertyGroup>
    <TargetFramework>net10.0</TargetFramework>
    <TreatWarningsAsErrors>true</TreatWarningsAsErrors>
    <ImplicitUsings>enable</ImplicitUsings>
    <Nullable>enable</Nullable>
  </PropertyGroup>
</Project>
```

`TreatWarningsAsErrors` is the important one. A nullable warning that nobody reads is a `NullReferenceException` waiting in production; as an error, it cannot be merged. A project that has a reason to differ appends to the default rather than replacing it: `Blouppy.Web.csproj` sets `<NoWarn>$(NoWarn);AV0029;AV0030</NoWarn>`, with a comment explaining why those two warnings do not apply.

`back/Directory.Packages.props` declares 91 `PackageVersion` items, grouped with `Label` attributes (`.NET`, `Aspire`, `Testing`...) so the file reads like a table of contents. A test project is then only a list of names:

```xml
<Project Sdk="Microsoft.NET.Sdk">

  <PropertyGroup>
    <OutputType>Exe</OutputType>
    <IsPackable>false</IsPackable>
    <IsTestProject>true</IsTestProject>
  </PropertyGroup>

  <ItemGroup>
    <PackageReference Include="AutoFixture" />
    <PackageReference Include="FluentAssertions" />
    <PackageReference Include="Moq" />
    <PackageReference Include="xunit.v3" />
    <PackageReference Include="xunit.runner.visualstudio">
      <IncludeAssets>runtime; build; native; contentfiles; analyzers; buildtransitive</IncludeAssets>
      <PrivateAssets>all</PrivateAssets>
    </PackageReference>
  </ItemGroup>

  <ItemGroup>
    <ProjectReference Include="..\Blouppy.Workspaces\Blouppy.Workspaces.csproj" />
  </ItemGroup>

</Project>
```

The Starter keeps these references in each test project rather than in a `Directory.Build.targets`. The 39 projects repeat the same lines, but each one says what it uses, and an integration test project can add `Testcontainers.PostgreSql` without a second condition. Both choices are reasonable; the versions are central either way.

The same file carries the [NuGet audit](https://learn.microsoft.com/nuget/concepts/auditing-packages) suppressions. Since .NET 10, the audit checks transitive packages by default, and with `TreatWarningsAsErrors` a vulnerability warning fails the build. When an advisory concerns a transitive package that cannot be upgraded yet, a `NuGetAuditSuppress` item with the advisory's URL silences it, next to a comment naming the package and what we are waiting for. One place lists every accepted risk.

`back/global.json`:

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

`10.0.100` is a floor. `rollForward: latestFeature` accepts any installed 10.0 SDK at or above it, so a developer on a newer feature band builds without installing another SDK, and a Linux distribution's package of the first 10.0 band still works.

The end-to-end suite shows the "nearest file wins" rule. It lives in `e2e/`, outside `back/`, so `back/Directory.Build.props` does not reach it. It has its own `Directory.Build.props` with the same four properties, its own `Directory.Packages.props` that mirrors the versions of the packages both sides use, and its own `global.json` with the test runner. A project-management app built on the Starter, with 144 projects, uses the same files unchanged.


## The pitfalls
**A version left in a `.csproj` breaks the build.** With CPM on, `<PackageReference Include="Moq" Version="4.20.72" />` fails restore with `NU1008`. That is the point, but it surprises whoever copies a snippet from a package's page: remove the `Version`, add a `PackageVersion` if there is none.

**A package missing from the central file breaks it too.** A `PackageReference` with no matching `PackageVersion` fails with `NU1010`. Adding a package is two edits in two files.

**Floating versions.** `Version="10.0.*"` means two restores on two days can produce two builds. By default, NuGet refuses a floating version in a central file (`NU1011`). We keep exact versions and let a bot raise them.

**Lock files are opt-in.** `RestorePackagesWithLockFile` writes a `packages.lock.json` per project, and `dotnet restore --locked-mode` fails when the graph changed. It makes the transitive graph reproducible, at the cost of one more file per project to commit and keep in sync: 105 of them here. The Starter does not use them; exact central versions and a pinned SDK floor were enough so far.

**Several roots.** MSBuild and NuGet take the nearest file and stop. A folder with its own `Directory.Build.props` silently drops the parent's settings, unless it imports them explicitly with `GetPathOfFileAbove`. The `e2e/` folder chose to duplicate four lines instead.

**Bots.** [Renovate](https://docs.renovatebot.com/modules/manager/nuget/) reads `Directory.Packages.props` and `global.json`: one pull request edits one line and updates every project. The Starter's configuration groups packages that ship together (the Wolverine packages, the xUnit ones) so they move in one pull request, caps FluentAssertions below 8 for licensing reasons, and disables the `dotnet-sdk` update so the `global.json` floor stays low on purpose. Dependabot also supports central package management; we have not used it on this solution, so we leave its details to its documentation.


## When not to bother
CPM pays for itself as soon as two projects share a package. For a single-project API, `Directory.Packages.props` is a second file to open for no gain, and `Directory.Build.props` only moves four lines.

`global.json` is different. Even a one-project repository benefits from it when the team or the CI may have several SDKs installed, and from the test runner setting when it uses Microsoft.Testing.Platform. A conditional `Directory.Build.targets` is the most optional of the four: it removes repetition, and it hides what a project depends on behind a condition.


## Conclusion
Three small files at the root of `back/` keep 105 projects consistent: `Directory.Packages.props` holds every version and every accepted audit risk, `Directory.Build.props` the four settings that make warnings fatal and nullability universal, and `global.json` the SDK floor and the test runner. The build enforces them: a version in a `.csproj` is `NU1008`, a missing one `NU1010`, a nullable warning an error. A bot then raises one line at a time.

This is how the back end of [Blouppy Starter](https://starter.blouppy.com/) is set up; the [architecture tests](/blog/2026-07-03-architecture-tests-that-fail-the-build/) keep the references between those projects in line in the same spirit.

## References
- [Central Package Management (Microsoft Learn)](https://learn.microsoft.com/nuget/consume-packages/central-package-management) — `Directory.Packages.props`, `VersionOverride`, `GlobalPackageReference` and transitive pinning.
- [Customize your build by folder (Microsoft Learn)](https://learn.microsoft.com/visualstudio/msbuild/customize-by-directory) — `Directory.Build.props`, `Directory.Build.targets` and the import order.
- [global.json overview (Microsoft Learn)](https://learn.microsoft.com/dotnet/core/tools/global-json) — SDK selection and `rollForward` policies.
- [Microsoft.Testing.Platform overview (Microsoft Learn)](https://learn.microsoft.com/dotnet/core/testing/microsoft-testing-platform-intro) — the test runner selected in `global.json`.
- [Auditing package dependencies (Microsoft Learn)](https://learn.microsoft.com/nuget/concepts/auditing-packages) — NuGet audit, its modes and `NuGetAuditSuppress`.
- [Lock files (Microsoft Learn)](https://learn.microsoft.com/nuget/consume-packages/package-references-in-project-files#locking-dependencies) — `RestorePackagesWithLockFile` and locked mode.
- [C# language versioning (Microsoft Learn)](https://learn.microsoft.com/dotnet/csharp/language-reference/configure-language-version) — the default `LangVersion` for each target framework.
- [Renovate NuGet manager (Renovate Docs)](https://docs.renovatebot.com/modules/manager/nuget/) — how Renovate finds and updates NuGet versions.
