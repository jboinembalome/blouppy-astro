---
templateKey: 'blog-post'
title: 'Architecture tests that fail the build: keeping a .NET solution honest'
date: 2026-07-03T09:00:00.000Z
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

Every team that splits a solution into domains, ports and adapters writes the rules down: "a domain never references another domain", "only the messaging adapter knows the bus library", "the read side never touches a write repository". Then a deadline arrives, someone adds one project reference "just this once", the reviewer is busy, and the rule in the wiki is now a wish.

The fix is to stop asking people to remember. The compiled assemblies already know what references what, and a unit test can read them. When a boundary is a test, breaking it is a red build, not a comment in a pull request.

In this article, we will look at how a real .NET solution expresses its boundaries as tests, what a failure says, how a new project gets covered without anybody listing it, and what to do when a rule is genuinely in the way.


## Two ways to read an assembly
The test project references every project it checks (the domains, the modules, the Web host, the identity host), then inspects what they compiled to. There are two tools for that, and the code base this comes from uses both, on purpose:
- **The reference graph**, with plain reflection: `Assembly.GetReferencedAssemblies()` returns the exact names an assembly was compiled against.
- **[NetArchTest](https://github.com/BenMorris/NetArchTest)** (`NetArchTest.Rules`), for rules about **types**: which types depend on a given type, which ones are public.

Why not NetArchTest everywhere? Its design note puts it plainly: **NetArchTest matches namespaces by prefix**. `Blouppy.Users` also matches `Blouppy.Users.PublicData`, which is exactly what a peer is allowed to use, and `Blouppy.Infrastructure.Database` also matches `Blouppy.Infrastructure.Database.Abstractions`, the port every domain legitimately references. The reference graph is exact and needs no escape hatch, so six of the eight domain rules are read off it.


## Expressing a rule
Let's start with the domains. Each one is described once, by its assemblies, in `DomainBoundaryTests.cs`:

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

Every assembly is anchored on a `typeof` rather than spelled as a string. The class's own comment gives the reason: "a rename either follows or fails to compile". A rule written as `"Blouppy.Workspace"` with a typo would match nothing and pass forever.

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

- `forbidden` is every other domain's implementation and models, computed from the table: adding a domain to `Domains` adds it to every rule at once.
- `ReferencedAssemblyNames` is a one-liner over `GetReferencedAssemblies()`, turned into a `HashSet<string>`.
- The `AssertionScope` from FluentAssertions collects every failing domain instead of stopping at the first one, so one run shows the whole damage.


## What a failure says
A boundary test is read by the person who broke it, in a CI log, months after the rule was written. So the `because` text is the most important line: it says **why** the rule exists.

If someone made `Blouppy.Workspaces` reference `Blouppy.Organizations` directly, FluentAssertions would combine the expression, the reason and what it found, something like:

```text:clipboard=false
Expected referenced.Intersect(forbidden) to be empty because Blouppy.Workspaces must reach its peers through their .PublicData alone, but found {"Blouppy.Organizations"}.
```

For the type-level rules, NetArchTest returns a `TestResult` with the failing types, and a small helper puts their names in the message:

```csharp
private static string FormatFailures(NetArchTest.Rules.TestResult result)
    => result.FailingTypeNames is null
        ? string.Empty
        : string.Join(", ", result.FailingTypeNames);
```

> **_Note:_**  `TestResult` exists in both `NetArchTest.Rules` and xUnit, hence the fully qualified name.

The reader knows which project, which type and which rule, without opening the wiki. 👍


## Type-level rules, and the vacuous pass
Rule 2 is the sideways door: the persistence contracts are shared, so a domain could read a peer's data through that peer's repository without naming any of its models. Here the rule is about types, so NetArchTest fits:

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

The important line is the `NotBeEmpty` in the middle. An architecture test that bans an empty list always passes: rename a namespace, and the rule silently checks nothing. That is why almost every test in the project has a guard such as "the rule is meaningless if …", or asserts that the scan finds the one thing it expects.

`ReadSideBoundaryTests.cs` uses the same two-phase form for the read side: it collects every interface whose name ends with `ApiQueryRepository`, checks the list is not empty, then asserts that neither the Web nor any domain depends on one. The prefix matching is not always a problem either: `The_read_models_should_stay_a_leaf` bans `"Blouppy.Infrastructure"` precisely **because** it matches every adapter and every port at once.

The same trap hides in NetArchTest's filters. The rule that keeps a domain's types `internal` excludes the DI entry point with `DoNotHaveName(...)`, not `DoNotResideInNamespace(...)`, because the latter matches by prefix and would exclude every type of the assembly, passing vacuously.

One rule the compiler cannot catch at all is a cycle: splitting `.PublicData` into its own project makes `Workspaces → Organizations.PublicData` together with `Organizations → Workspaces.PublicData` legal. `The_public_contracts_should_not_form_a_cycle` builds that graph from the references and walks it with a depth-first search, printing the cycle as `A → B → A` when it finds one.


## A new adapter without a row fails the build
Listing projects by hand has the same weakness as a wiki: nobody updates the list. So the adapters are not listed, they are **found**. `HostComposition.cs` walks the references of the hosts, starting from `Blouppy.Web.Startup` (and the identity host's `Startup`):

```csharp
private static Assembly[] BlouppyAssembliesComposedBy(Assembly root)
{
    var found = new Dictionary<string, Assembly>();
    var pending = new Queue<Assembly>([root]);

    while (pending.TryDequeue(out var assembly))
    {
        if (!found.TryAdd(NameOf(assembly), assembly))
        {
            continue;
        }

        foreach (var reference in assembly.GetReferencedAssemblies().Where(x => IsSolutionProject(x.Name!)))
        {
            if (!found.ContainsKey(reference.Name!))
            {
                pending.Enqueue(Assembly.Load(reference));
            }
        }
    }

    return found.Values.ToArray();
}
```

From that set, `InfrastructureAdapters` keeps every `Blouppy.Infrastructure.<Concern>` that does not end with `.Abstractions`. A project added next year is covered the day the host references it.

Then `InfrastructureBoundaryTests.cs` holds one row per adapter: the Blouppy projects it may reference.

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

And two tests tie the rows to the real projects:

```csharp
[Fact]
public void Every_adapter_should_have_a_row_and_every_row_an_adapter()
{
    // Act
    var adapters = HostComposition.InfrastructureAdapters
        .Select(HostComposition.NameOf)
        .ToArray();

    // Assert
    adapters
        .Should()
        .NotBeEmpty("the rule is meaningless if no adapter is found")
        .And
        .BeEquivalentTo(
            AllowedReferences.Keys,
            "an adapter with no row could reference anything, and a row with no adapter checks nothing");
}
```

- A new `Blouppy.Infrastructure.Search`, referenced by the Web, appears in `adapters` but not in the keys: red build.
- A row for a project that was deleted appears in the keys but not in `adapters`: red build too, so the table cannot go stale.
- `An_adapter_should_reference_only_what_its_row_allows` then compares each adapter's references with its row, and `A_port_should_reference_no_adapter` checks the other direction.

The rows are keyed by **name**, not by `typeof`, for a reason the comment gives: "a row exists before its project does". The person adding the adapter writes its row first, and the comment above the row is where the decision lives (why `RealTime` is the one adapter allowed to reach another adapter, for example).


## Beyond references: who injects what
Some boundaries are about types, not projects. Every model call must go through one class, the AI gateway, because it checks a switch and writes a ledger. `LlmBoundaryTests.cs` scans every type of the host for constructor parameters:

```csharp
private static bool Injects(Type type, Func<Type, bool> isDependency)
    => !type.IsDefined(typeof(CompilerGeneratedAttribute), inherit: false)
       && !IsRecord(type)
       && type.GetConstructors(BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic)
           .SelectMany(x => x.GetParameters())
           .Any(x => Mentions(x.ParameterType, isDependency));
```

Then it asserts that the list of types injecting `ILlmClient` is exactly `["Blouppy.Ai.Gateway.AiGateway"]`. `Mentions` also looks inside generics and arrays, so `IEnumerable<ILlmClient>` or `Lazy<ILlmClient>` does not slip through. Note the shape of the assertion: `BeEquivalentTo([GatewayName])`, not "is empty". The expected type being found is what proves the scan sees anything.

`BusLibraryBoundaryTests.cs` does the same with packages: only the messaging adapter may reference an assembly starting with `Wolverine`, `JasperFx`, `Weasel` or `MassTransit`. Its comment gives the payoff: the library can be swapped (MassTransit already was, for Wolverine) by rewriting one project.


## Coverage tables: a decision per member
The last pattern goes further than references: it forces a **decision**. Every write method of a driving port (an `IXxxService` in a `.Abstractions` project) must have a row in `AuditCoverage.cs`, saying whether the audit log records it:

```csharp
["IWorkspacesService.TryAddAsync"] = new NotAudited(Reversible),
["IWorkspacesService.TryDeleteAsync"] = new Audited(AuditEventType.WorkspaceDeleted),
["IWebhooksService.TryRotateSecretAsync"] = new Audited(AuditEventType.WebhookSecretRotated),
```

`AuditCoverageTests.cs` finds the writes by reflection (any method whose name does not start with `Get`, `List`, `Search`, `Is`, `Can` and a few others, followed by an upper-case letter, so `CancelAsync` is not a `Can`) and fails on any write without a row:

```csharp
var missing = writes.Except(AuditCoverage.Rows.Keys).ToArray();

missing
    .Should()
    .BeEmpty($"each write is audited or excluded with a reason in AuditCoverage, and these say neither: {string.Join(", ", missing)}");
```

`NotAudited` takes a mandatory `Reason`, so "not audited" can never be an accident. The rule leans one way on purpose: a read misnamed costs a `NotAudited` row, a write misnamed would cost a missing audit entry. And like the adapters' table, `Every_row_should_name_a_write_that_exists` fails on rows for methods that are gone.


## Change the rule deliberately
Sooner or later, a rule will be in the way. Maybe a new adapter really does need a second port, or a domain really needs a fact from a peer. There are two ways out:
- **Route around it**: make a type public "temporarily", add a string comparison that skips one project, move the code to a project the test does not look at. The build is green and the boundary is gone, without anybody having decided it.
- **Change the rule**: add the reference to the adapter's row with a comment that says why, add the `.PublicData` to the domain's entry, write the `NotAudited` reason. The change is in the diff, in one file, where the reviewer sees it.

The code base's own guidance says it in one line: if a rule is in the way, change the rule in `Blouppy.Architecture.UnitTests` deliberately, because routing around it is how the boundaries erode. The tests do not make the architecture rigid; they make every exception visible. 😉


## Conclusion
Architecture rules written in a wiki depend on reviewers remembering them. Rules written as tests over the compiled assemblies depend on nothing: `GetReferencedAssemblies()` for the exact project graph, NetArchTest for the type-level rules, and a `because` text that tells the next developer why the build is red.

A few habits make them hold over time: anchor names on `typeof`, guard every scan against an empty result, find the projects by walking the host rather than listing them, and keep tables whose keys must match reality in both directions. When a rule needs to change, change it in the open.

This is how the boundaries of [Blouppy Starter](https://starter.blouppy.com/) are kept, across its domains, modules and adapters; the [hexagonal architecture choice](https://docs.starter.blouppy.com/choices/hexagonal/) explains what those tests protect and what they cost.

*Thanks for reading! 🙂*
