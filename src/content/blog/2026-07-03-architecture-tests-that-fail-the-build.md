---
templateKey: 'blog-post'
title: 'Architecture tests that fail the build: keeping a .NET solution honest'
date: 2026-07-03T09:00:00.000Z
updated: 2026-11-07T09:00:00.000Z
author: Jimmy Boinembalome
authorimage: /img/jimmy.jpg
category: C#
topic: 'Architecture'
illustration: 2
categorycolor: bg-purple-100 text-purple-800
featuredpost: true
featuredimage: /img/architecture-tests-that-fail-the-build.jpg
description: >-
  Learn how to turn the boundaries of a .NET solution into tests that read the compiled assemblies, so that a wrong reference fails the build instead of a code review.
tags:
  - Development
  - C#
  - .NET
  - Architecture
  - Testing
---

Every team that splits a solution into domains, ports and adapters writes the rules down: "a domain never references another domain". Then a deadline arrives, someone adds one project reference "just this once", and the rule in the wiki becomes a wish.

The compiled assemblies already know what references what, and a unit test can read them. When a boundary is a test, breaking it is a red build, not a comment in a pull request.

In this article, we will look at how Blouppy Starter expresses its boundaries as tests, what a failure says, how a new project gets covered without anybody listing it, and what to do when a rule is in the way.


## Two ways to read an assembly
The test project references every project it checks (the domains, the modules, the Web host, the identity host) and inspects what they compiled to, with two tools:
- **The reference graph**, with plain reflection: [`Assembly.GetReferencedAssemblies()`](https://learn.microsoft.com/dotnet/api/system.reflection.assembly.getreferencedassemblies) returns the exact names an assembly was compiled against.
- **[NetArchTest](https://www.nuget.org/packages/NetArchTest.Rules)** (`NetArchTest.Rules`), for rules about **types**: which types depend on a given type, which ones are public.

Why not NetArchTest everywhere? Because **NetArchTest matches namespaces by prefix**. `Blouppy.Users` also matches `Blouppy.Users.PublicData`, which a peer is allowed to use, and `Blouppy.Infrastructure.Database` also matches `Blouppy.Infrastructure.Database.Abstractions`, the port every domain legitimately references. The reference graph is exact, so six of the eight domain rules are read from it.


## Expressing a rule
Each domain is described once, by its assemblies, in `DomainBoundaryTests.cs`:

```csharp
private sealed record Domain(
    Assembly Implementation,
    Assembly Models,
    Assembly? PublicData,
    Assembly? Abstractions,
    Type DatabasePort)
{
    public string Name => Implementation.GetName().Name!;
}

private static readonly Domain[] Domains =
[
    new(
        typeof(Blouppy.Workspaces.ServiceCollectionExtensions).Assembly,
        typeof(Workspace).Assembly,
        typeof(IWorkspacesPublicDataService).Assembly,
        typeof(IWorkspacesService).Assembly,
        typeof(IWorkspacesRepository)),
    // ... one entry per domain and module
];
```

Every assembly is anchored on a `typeof` rather than spelled as a string, so, as the class comment puts it, "a rename either follows or fails to compile". A rule written as `"Blouppy.Workspace"` with a typo would match nothing and pass forever.

Here is the first rule, "a domain can only name what a peer's `.PublicData` declares":

```csharp
[Fact]
public void A_domain_should_not_reference_another_domain_or_its_models()
{
    using var scope = new AssertionScope();

    foreach (var domain in Domains)
    {
        // Arrange
        var forbidden = Domains
            .Where(x => x != domain)
            .SelectMany(x => new[] { x.Implementation.GetName().Name!, x.Models.GetName().Name! })
            .ToArray();

        // Act
        var referenced = ReferencedAssemblyNames(domain.Implementation);

        // Assert
        referenced
            .Intersect(forbidden)
            .Should()
            .BeEmpty($"{domain.Name} must reach its peers through their .PublicData alone");
    }
}
```

`forbidden` is computed from the table, so a domain added to `Domains` joins every rule at once. `ReferencedAssemblyNames` turns `GetReferencedAssemblies()` into a `HashSet<string>`, and FluentAssertions' [`AssertionScope`](https://fluentassertions.com/introduction) collects every failing domain instead of stopping at the first.


## What a failure says
A boundary test is read by the person who broke it, in a CI log, months later, so the `because` text matters most: it says **why** the rule exists. If `Blouppy.Workspaces` referenced `Blouppy.Organizations` directly, the message would read along these lines:

```text:clipboard=false
Expected referenced.Intersect(forbidden) to be empty because Blouppy.Workspaces must reach its peers through their .PublicData alone, but found {"Blouppy.Organizations"}.
```

For type-level rules, NetArchTest returns a `TestResult`, and a small `FormatFailures` helper joins its `FailingTypeNames` into the message. The reader knows which project, which type and which rule, without opening the wiki.


## Type-level rules, and the vacuous pass
Rule 2 closes a side door: the persistence contracts are shared, so a domain could read a peer's data through that peer's repository without naming any of its models. This rule is about types, so NetArchTest fits:

```csharp
var foreignPorts = Domains
    .Where(x => x != domain)
    .SelectMany(WriteRepositoryNamesOwnedBy)
    .ToArray();

foreignPorts
    .Should()
    .NotBeEmpty("the rule is meaningless if no foreign repository is found");

var result = Types.InAssembly(domain.Implementation)
    .That()
    .AreNotNested()
    .ShouldNot()
    .HaveDependencyOnAny(foreignPorts)
    .GetResult();

result.IsSuccessful
    .Should()
    .BeTrue($"{domain.Name} must not read another domain's data through its repository, but these types do: {FormatFailures(result)}");
```

The important line is the `NotBeEmpty`. An architecture test that bans an empty list always passes: rename a namespace, and the rule silently checks nothing. That is why almost every test in the project guards its scan ("the rule is meaningless if …") or asserts that it finds the one thing it expects. `ReadSideBoundaryTests.cs` uses the same two-phase form: collect every interface whose name ends with `ApiQueryRepository`, check the list is not empty, then ban it from the Web and the domains.

The same trap hides in NetArchTest's filters. The rule that keeps a domain's types `internal` excludes the DI entry point with `DoNotHaveName(...)`, not `DoNotResideInNamespace(...)`: the latter matches by prefix, would exclude every type of the assembly, and would pass vacuously.

The compiler also allows a cycle between public contracts (`Workspaces → Organizations.PublicData` and `Organizations → Workspaces.PublicData`), so `The_public_contracts_should_not_form_a_cycle` walks the reference graph depth first and prints any cycle as `A → B → A`.


## A new adapter without a row fails the build
A hand-written list of projects has the same weakness as a wiki: nobody updates it. So the adapters are **found**, not listed. `HostComposition.cs` walks the references of the API's and the identity host's `Startup` assemblies breadth first (a `Queue<Assembly>`, `GetReferencedAssemblies()` filtered to the solution's projects, `Assembly.Load` on each new one). From that set, `InfrastructureAdapters` keeps every `Blouppy.Infrastructure.<Concern>` that does not end with `.Abstractions`. A project added next year is covered the day a host references it.

`InfrastructureBoundaryTests.cs` then holds one row per adapter, listing the Blouppy projects it may reference:

```csharp
private static readonly Dictionary<string, string[]> AllowedReferences = new()
{
    ["Blouppy.Infrastructure.Caching"] =
    [
        "Blouppy.Infrastructure.Caching.Abstractions",
        "Blouppy.SharedKernel"
    ],
    // A model provider's adapter knows nothing of Blouppy's beyond its port: what it sends is the gateway's to decide.
    ["Blouppy.Infrastructure.Llm"] =
    [
        "Blouppy.Infrastructure.Llm.Abstractions"
    ],
    // ...
};
```

`Every_adapter_should_have_a_row_and_every_row_an_adapter` then asserts that the adapters found are not empty and are equivalent to `AllowedReferences.Keys`, with the reason "an adapter with no row could reference anything, and a row with no adapter checks nothing". A new `Blouppy.Infrastructure.Search` referenced by the Web appears in `adapters` but not in the keys: red build. A row for a deleted project appears in the keys but not in `adapters`: red build too, so the table cannot go stale. `An_adapter_should_reference_only_what_its_row_allows` then compares each adapter's references with its row, and `A_port_should_reference_no_adapter` checks the other direction.

The rows are keyed by **name**, not by `typeof`, because "a row exists before its project does", and the comment above a row records the decision (why `RealTime` may reach another adapter, for example).


## Beyond references: who injects what
Some boundaries are about types, not projects. Every model call must go through one class, the AI gateway, because it checks a switch and writes a usage ledger. `LlmBoundaryTests.cs` scans the constructor parameters of every type the host composes, generics and arrays included (so `Lazy<ILlmClient>` cannot slip through), and asserts that the types injecting `ILlmClient` are exactly `["Blouppy.Ai.Gateway.AiGateway"]`. Note the shape: `BeEquivalentTo([GatewayName])`, not "is empty". Finding the expected type is what proves the scan sees anything.

`BusLibraryBoundaryTests.cs` does the same with packages: only the messaging adapter may reference an assembly whose name starts with `Wolverine`, `JasperFx`, `Weasel` or `MassTransit`. The payoff is in its comment: the library can be swapped (MassTransit already was, for Wolverine) by rewriting one project.


## Coverage tables: a decision per member
The last pattern forces a **decision**. Every write method of a driving port (an `IXxxService` in a `.Abstractions` project) needs a row in `AuditCoverage.cs`, saying whether the audit log records it:

```csharp
["IWorkspacesService.TryAddAsync"] = new NotAudited(Reversible),
["IWorkspacesService.TryDeleteAsync"] = new Audited(AuditEventType.WorkspaceDeleted),
["IWebhooksService.TryRotateSecretAsync"] = new Audited(AuditEventType.WebhookSecretRotated),
```

`AuditCoverageTests.cs` finds the writes by reflection (any method whose name does not start with a read prefix such as `Get`, `List` or `Can` followed by an upper-case letter, so `CancelAsync` is a write) and fails on any write without a row, naming each one.

`NotAudited` takes a mandatory reason, so "not audited" is never an accident, and `Every_row_should_name_a_write_that_exists` fails on rows for methods that are gone.


## Change the rule deliberately
Sooner or later, a rule will be in the way. Routing around it (a type made public "temporarily", a string comparison that skips one project) leaves the build green and the boundary gone, without anybody deciding it. Changing the rule (a reference added to the adapter's row with a comment that says why, a `NotAudited` reason) puts the decision in the diff, in one file, where the reviewer sees it. The Starter's README says it in one line: "change the rule deliberately rather than routing around it". The tests do not make the architecture rigid; they make every exception visible.


## Conclusion
Rules in a wiki depend on reviewers remembering them. Rules written as tests over the compiled assemblies do not: `GetReferencedAssemblies()` for the exact project graph, NetArchTest for type-level rules, and a `because` text that tells the next developer why the build is red. A few habits make them hold: anchor names on `typeof`, guard every scan against an empty result, find projects by walking the host, and keep tables whose keys must match reality in both directions.

This is how the boundaries of [Blouppy Starter](https://starter.blouppy.com/) are kept across its domains, modules and adapters.


## References
- [`Assembly.GetReferencedAssemblies`](https://learn.microsoft.com/dotnet/api/system.reflection.assembly.getreferencedassemblies) (API reference) — the reference graph the project-level rules read.
- [Architectural principles](https://learn.microsoft.com/dotnet/architecture/modern-web-apps-azure/architectural-principles) (Microsoft Learn) — dependency inversion and separation of concerns, the rules these tests enforce.
- [NetArchTest.Rules](https://www.nuget.org/packages/NetArchTest.Rules) (NuGet) — the fluent API for type-level rules.
- [ArchUnitNET](https://archunitnet.readthedocs.io/) — an alternative library for the same kind of tests.
- [FluentAssertions introduction](https://fluentassertions.com/introduction) — `because` messages and assertion scopes.
- [Hexagonal architecture](https://docs.starter.blouppy.com/choices/hexagonal/) (Blouppy Starter docs) — what the tests protect and what they cost.
- [Domains and modules](https://docs.starter.blouppy.com/architecture/domains-and-modules) (Blouppy Starter docs) — the boundaries between domains.
