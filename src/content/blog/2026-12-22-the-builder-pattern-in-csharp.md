---
templateKey: 'blog-post'
title: 'The Builder pattern in C#: fluent, immutable and for tests'
date: 2026-12-22T09:00:00.000Z
author: Jimmy Boinembalome
authorimage: /img/jimmy.jpg
category: C#
topic: 'Architecture'
illustration: 3
categorycolor: bg-purple-100 text-purple-800
featuredpost: true
description: >-
  Learn when a fluent builder beats a constructor or an object initializer in C#, how to make one immutable, what to validate in Build() and how builders keep tests short.
tags:
  - Development
  - C#
  - Design Patterns
  - Testing
---

Some objects are awkward to create. An e-mail needs a recipient and a subject, may have a reason in its footer, and is HTML unless told otherwise. A Content Security Policy is a list of a dozen directives, each with its own sources. A test for an authorization handler needs a requirement, a resource and a user with the right claims. A constructor with eight parameters makes every call site a guessing game, and setting properties one by one gives no place to check that the result makes sense.

In this article, we will look at the **Builder pattern**: where it comes from, its minimal shape, the builders .NET developers already use every day, three real ones from [Blouppy Starter](https://starter.blouppy.com/) (a mutable e-mail builder, an immutable policy builder and test data builders), and the cases where an object initializer is all we need.


## Where the pattern comes from
The Builder is one of the **creational** patterns of the Gang of Four's *Design Patterns* (1994). Its intent is to separate the construction of a complex object from its representation, so the same construction process can produce different results. The book's version has a `Builder` interface, concrete builders, and a **director** that calls the building steps in order. In C#, the director is rarely a class of its own: it is usually the method that chains the calls.

What .NET developers mean by a builder today is mostly the fluent form: a series of method calls, each returning the builder, ending with `Build()`.


## The problem: telescoping constructors
Before builders, the usual answer to optional parameters was a family of constructors, each adding one:

```csharp
public Email(string to, string subject) { ... }
public Email(string to, string subject, string body) { ... }
public Email(string to, string subject, string body, string? reason) { ... }
public Email(string to, string subject, string body, string? reason, bool isHtml) { ... }
```

Call sites read as `new Email("a@b.c", "Hi", "", null, false)`, and nothing tells us which `string` is which. Named and optional arguments help, and C# also has object initializers and, since C# 11, **required members**:

```csharp
public sealed record Email
{
    public required string To { get; init; }
    public required string Subject { get; init; }
    public string Body { get; init; } = string.Empty;
    public bool IsHtml { get; init; } = true;
}

var email = new Email { To = "a@b.c", Subject = "Hi" };
```

Forgetting `To` is now a compile error, the properties cannot change after creation, and the call site names every value. For a plain data object, this is enough, and a builder on top would be overkill. A builder earns its place when construction needs more than assignment: a check across several values, defaults that depend on other values, a step that appends instead of replacing, or a product that should not be built until everything is known.


## The minimal shape
A fluent builder keeps its state in private fields, returns `this` from each step and creates the product in `Build()`:

```csharp
namespace Builders;

public sealed class PizzaBuilder
{
    private string? _size;
    private readonly List<string> _toppings = [];

    public PizzaBuilder Size(string size)
    {
        _size = size;

        return this;
    }

    public PizzaBuilder Topping(string topping)
    {
        _toppings.Add(topping);

        return this;
    }

    public Pizza Build()
    {
        if (string.IsNullOrWhiteSpace(_size))
        {
            throw new InvalidOperationException("Size must be set.");
        }

        return new Pizza(_size, [.. _toppings]);
    }
}
```

Two details matter. `Topping` can be called several times and accumulates, which an initializer cannot express. And `Build()` copies the list, so the pizza does not share state with the builder that made it.


## Builders we already use
Most .NET code already goes through several builders a day:

- `WebApplication.CreateBuilder(args)` returns a `WebApplicationBuilder`. We add services and configuration to it, then `builder.Build()` produces the `WebApplication`, after which the service collection can no longer be changed.
- `StringBuilder` appends pieces into a buffer and `ToString()` produces the string. `Append` returns the builder, so calls chain.
- EF Core's fluent API: `modelBuilder.Entity<Workspace>()` returns an `EntityTypeBuilder<Workspace>`, and `.Property(x => x.Name).HasMaxLength(200).IsRequired()` chains on a `PropertyBuilder`. The model is built once from all these calls.
- `UriBuilder` sets `Scheme`, `Host`, `Path` and `Query` as properties, then `.Uri` gives the result. It is a builder without the fluent style.
- The immutable collections have one too: `ImmutableList<T>.Builder` (from `ToBuilder()` or `ImmutableList.CreateBuilder<T>()`) is a mutable list that becomes an immutable one with `ToImmutable()`.


## A mutable fluent builder: `EmailTemplateBuilder`
In Blouppy Starter, every e-mail goes through `IEmailSender`, the port of the e-mail adapter, as an `EmailMessage`. The adapter wraps the body in the house layout (header, footer, legal links), so a caller only provides the content. Callers build the message with `EmailTemplateBuilder`, from the same `.Abstractions` project:

```csharp
namespace Blouppy.Infrastructure.Email.Abstractions;

public sealed class EmailTemplateBuilder
{
    private string? _to;
    private string? _subject;
    private string? _bodyHtml;
    private string? _reason;
    private bool _isHtml = true;

    public EmailTemplateBuilder To(string to)
    {
        _to = to;

        return this;
    }

    public EmailTemplateBuilder Subject(string subject) { ... }
    public EmailTemplateBuilder Body(string htmlBody) { ... }
    public EmailTemplateBuilder Reason(string reason) { ... }
    public EmailTemplateBuilder IsHtml(bool isHtml) { ... }

    public EmailMessage Build()
    {
        if (string.IsNullOrWhiteSpace(_to))
        {
            throw new InvalidOperationException("Recipient (To) must be set.");
        }

        if (string.IsNullOrWhiteSpace(_subject))
        {
            throw new InvalidOperationException("Subject must be set.");
        }

        return new EmailMessage
        {
            To = _to,
            Subject = _subject,
            Body = _bodyHtml ?? string.Empty,
            Reason = string.IsNullOrWhiteSpace(_reason) ? null : _reason,
            IsHtml = _isHtml
        };
    }
}
```

`Build()` does three things an initializer would not. It refuses an empty or whitespace recipient and subject, which `required` cannot catch since `""` satisfies it. It defaults a missing body to an empty string. And it turns a blank reason into `null`, so the footer says nothing instead of printing an empty sentence.

The invitation handler of the Organizations domain shows the call site reading like the e-mail itself:

```csharp
return new EmailTemplateBuilder()
    .To(invitation.Email)
    .Subject($"Invitation to join {organization.Name}")
    .Reason("This invitation was sent because someone invited you to this organization.")
    .Body(body)
    .Build();
```

The notification dispatcher, which has no reason to give, simply skips that step: `.To(...).Subject(subject).Body(body).Build()`. Skipping a step is the whole point: optional values cost nothing at the call site.

This builder is **mutable**: each step changes the instance and returns it. That is fine here because a builder lives for one expression and is never shared. The cost is that the validation happens at run time. A missing subject is an exception when the message is built, where a `required` property would have been a compile error. The `EmailMessage` record itself still declares `To`, `Subject` and `Body` as `required`, so code that skips the builder is held to the compile-time rule.


## An immutable fluent builder: `ContentSecurityPolicy`
The second example is shaped differently. We covered the policy itself in [a strict Content Security Policy for an Angular SPA](/blog/2026-08-26-strict-content-security-policy-for-an-angular-spa/); here we look only at how it is built. Each host declares its policy as a **static** property:

```csharp
namespace Blouppy.Web.Security;

internal static class ContentSecurityPolicies
{
    public static ContentSecurityPolicy Api { get; } = ContentSecurityPolicy.Create()
        .With("default-src", "'none'")
        .With("script-src", "'self'")
        .With("style-src", "'self'", "'unsafe-inline'")
        .With("img-src", "'self'", "data:")
        .With("connect-src", "'self'")
        .With("frame-ancestors", "'none'");
}
```

It looks like the e-mail builder, but `With` never changes the instance it is called on. It copies the directives, adds or extends one, and returns a **new** policy:

```csharp
namespace Blouppy.Aspire.ServiceDefaults.Security;

public sealed class ContentSecurityPolicy
{
    private readonly List<Directive> _directives;

    private ContentSecurityPolicy(List<Directive> directives)
        => _directives = directives;

    public static ContentSecurityPolicy Create()
        => new([]);

    public ContentSecurityPolicy With(string directive, params string[] sources)
    {
        var directives = new List<Directive>(_directives);

        var index = directives.FindIndex(candidate =>
            string.Equals(candidate.Name, directive, StringComparison.OrdinalIgnoreCase));

        if (index < 0)
        {
            directives.Add(new Directive(directive, [.. sources]));
        }
        else
        {
            directives[index] = directives[index].Append(sources);
        }

        return new ContentSecurityPolicy(directives);
    }

    private sealed record Directive(string Name, string[] Sources)
    {
        public Directive Append(string[] sources)
            => this with { Sources = [.. Sources, .. sources] };
    }
}
```

Immutability matters because of where the policy lives. `ContentSecurityPolicies.Api` is one static instance for the whole process. At startup, `UseContentSecurityPolicy` widens it with what the environment's configuration adds:

```csharp
Policy: policy
    .WithAdditionalSources(options.AdditionalSources)
    .WithReportUri(options.ReportUri)
```

If `With` mutated the instance, this line would change the static declaration itself. Anything else reading `ContentSecurityPolicies.Api` (another test, a second application built in the same test process) would see sources it never asked for, and calling the setup twice would append them twice. Because each step returns a copy, the declared policy stays exactly as written, and the widened one belongs to the middleware alone. The same reasoning lets `ToHeaderValue(nonce)` append a per-request nonce to `script-src` on a copy, and cache the rendered header of the policy without a nonce: a value that cannot change can be computed once.

The small `Directive` record shows the language's own immutable builder: a `with` expression copies a record and replaces the properties named.

There is no `Build()` here: every intermediate policy is already a valid, usable object, and `ToHeaderValue()` is where it is turned into a string. That is common for immutable builders, where the builder and the product are the same type.


## Builders for tests
The third use is in tests. An authorization handler takes an `AuthorizationHandlerContext`, which needs requirements, a `ClaimsPrincipal` and a resource. Writing the claims by hand in every test buries what the test is about. The Web's unit tests have `AuthorizationHandlerContextBuilder`:

```csharp
namespace Blouppy.Web.UnitTests.Utilities.Authorization;

internal sealed class AuthorizationHandlerContextBuilder
{
    private readonly IAuthorizationRequirement[] _requirements;
    private readonly List<Claim> _claims = [];
    private object? _resource;

    private AuthorizationHandlerContextBuilder(IAuthorizationRequirement[] requirements)
        => _requirements = requirements;

    public static AuthorizationHandlerContextBuilder For(params IAuthorizationRequirement[] requirements)
        => new(requirements);

    public AuthorizationHandlerContextBuilder OnResource(object resource) { ... }

    public AuthorizationHandlerContextBuilder WithSubject(Action<ISubjectBuilder> configure)
    {
        var subject = new SubjectBuilder();

        configure(subject);

        _claims.AddRange(subject.Build());

        return this;
    }

    public AuthorizationHandlerContext Build()
    {
        var user = new ClaimsPrincipal(new ClaimsIdentity(_claims, authenticationType: "test"));

        return new AuthorizationHandlerContext(_requirements, user, _resource);
    }
}
```

`WithSubject` takes a nested builder through a lambda, the same style as `services.Configure<T>(options => ...)`. `SubjectBuilder` offers `WithId`, `WithClient` and `WithRoles` through the `ISubjectBuilder` interface, while its `Build()` stays `internal` to the outer builder. A test then states only what it is about:

```csharp
var context = AuthorizationHandlerContextBuilder
    .For(new MinimumRoleRequirement(OrganizationRole.Admin))
    .OnResource(resource)
    .WithSubject(subject => subject
        .WithId(userId))
    .Build();
```

The identity is always authenticated with the `"test"` type, no resource is the default, and a test that checks the personal access token client adds `.WithClient(...)` and nothing else. This is what Nat Pryce called a **test data builder**: sensible defaults, and only the values that matter to the test are set. When the context's construction changes, one class changes, not every test.


## When not to use a builder
A builder is one more class to write, test and keep in sync with the product. Adding a property means adding a field, a method and a line in `Build()`. Some guidance:

- **A data object with a few properties**: an object initializer with `required` and `init` is enough, and it checks at compile time what a builder checks at run time.
- **Two or three optional parameters**: named and optional arguments on a constructor or a factory method read just as well.
- **A one-off object in production code**: a builder pays off when many call sites build the same type with different subsets of values.
- **A builder that only assigns**: if `Build()` validates nothing, normalises nothing and accumulates nothing, it is an object initializer with extra steps.

Choose mutable or immutable deliberately. A mutable builder is cheaper and fine for an instance that lives in one expression. An immutable one costs a copy per step, which is nothing for a policy built once at startup but would matter in a hot loop, and it is the only safe choice for an instance that is shared or stored in a static.


## Conclusion
The Builder pattern is the Gang of Four's answer to objects that are hard to create in one call. In modern C#, required members and object initializers cover the simple cases, so a builder is worth it when construction has rules: validation across values in `Build()`, defaults, steps that accumulate. A mutable fluent builder like `EmailTemplateBuilder` suits one-shot construction; an immutable one like `ContentSecurityPolicy` suits a shared, static value that other code extends; and test data builders keep each test down to the values it is about.


## References
- [Design Patterns: Elements of Reusable Object-Oriented Software](https://en.wikipedia.org/wiki/Design_Patterns) — the Gang of Four book that catalogues the Builder.
- [Builder (Refactoring.Guru)](https://refactoring.guru/design-patterns/builder) — an illustrated explanation with the director role.
- [Required members (Microsoft Learn)](https://learn.microsoft.com/dotnet/csharp/language-reference/proposals/csharp-11.0/required-members) — the C# 11 feature that makes many builders unnecessary.
- [Object and collection initializers (Microsoft Learn)](https://learn.microsoft.com/dotnet/csharp/programming-guide/classes-and-structs/object-and-collection-initializers) — the language's built-in alternative.
- [Test Data Builders: an alternative to the Object Mother pattern](http://www.natpryce.com/articles/000714.html) — Nat Pryce's article on builders for tests.
- [Fluent API configuration (EF Core)](https://learn.microsoft.com/ef/core/modeling/) — `ModelBuilder` and `EntityTypeBuilder` in practice.
- [A strict Content Security Policy for an Angular SPA served by ASP.NET Core](/blog/2026-08-26-strict-content-security-policy-for-an-angular-spa/) — the policy the immutable builder produces.
