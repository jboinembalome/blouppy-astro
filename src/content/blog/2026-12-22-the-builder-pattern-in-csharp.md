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

Some objects are awkward to create. An e-mail needs a recipient and a subject, may have a reason in its footer, and is HTML unless told otherwise. A constructor with five parameters makes every call site a guessing game: `new Email("a@b.c", "Hi", "", null, false)` says nothing about which `string` is which. Setting properties one by one gives no place to check that the result makes sense.

The Builder pattern gives construction a place of its own.


## Do we still need it?
The Builder is one of the Gang of Four's creational patterns. Its intent is to separate how a complex object is built from what it is. In .NET today, it mostly means the fluent form: a chain of calls, each returning the builder, ending with `Build()`. We use several every day: `WebApplication.CreateBuilder`, `StringBuilder`, EF Core's `modelBuilder.Entity<T>()`.

Modern C# removes much of the need, though. Object initializers and, since C# 11, required members cover a plain data object:

```csharp
public sealed record EmailMessage
{
    public required string To { get; init; }
    public required string Subject { get; init; }
    public string Body { get; init; } = string.Empty;
    public bool IsHtml { get; init; } = true;
}

var email = new EmailMessage { To = "a@b.c", Subject = "Hi" };
```

Forgetting `To` is a compile error. The call site names every value, and nothing changes after creation. A builder on top would be overkill. It earns its place when construction needs more than assignment: a check across values, a default that depends on another value, a step that appends instead of replacing.


## A builder with rules
[Blouppy Starter](https://starter.blouppy.com/) sends every e-mail through its e-mail port as an `EmailMessage`, much like the record above. Callers build it with `EmailTemplateBuilder`. Each step stores a value in a field and returns `this`; `Build()` is where the rules live:

```csharp
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
```

`Build()` does three things an initializer cannot. It refuses a whitespace recipient or subject, which `required` lets through, since `""` satisfies it. It defaults a missing body. And it turns a blank reason into `null`, so the footer prints nothing instead of an empty sentence.

The call site then reads like the e-mail itself:

```csharp
return new EmailTemplateBuilder()
    .To(invitation.Email)
    .Subject($"Invitation to join {organization.Name}")
    .Reason("This invitation was sent because someone invited you to this organization.")
    .Body(body)
    .Build();
```

A caller with no reason to give skips that step. That is the point: an optional value costs nothing at the call site.

The price is that the check moves to run time. A missing subject is an exception when the message is built, not a compile error. The `EmailMessage` record still declares its main properties `required`, so code that skips the builder keeps the compile-time rule.


## Mutable or immutable
`EmailTemplateBuilder` is **mutable**: each step changes the instance. That is fine because a builder lives for one expression and is never shared.

A builder stored in a static is a different story. The Starter's `ContentSecurityPolicy` is declared once per host, as a static property built with `.With("script-src", "'self'")` and so on. At startup, the middleware widens it with the sources the environment's configuration adds. If `With` changed the instance, that would change the static declaration itself: a second application built in the same test process would see sources it never asked for. So `With` copies the directives, adds or extends one, and returns a **new** policy. The declared one stays exactly as written. It also means the rendered header can be cached: a value that cannot change can be computed once.

An immutable builder has no `Build()`. Every intermediate policy is already valid, and the builder and the product are the same type. C# records do the same with a `with` expression.

A copy per step is nothing for a policy built at startup, but it would matter in a hot loop. Pick immutable for what is shared or static, mutable for the rest.


## Builders in tests
Tests are where builders pay off most. An authorization handler test needs an `AuthorizationHandlerContext`: requirements, a resource, and a `ClaimsPrincipal` with the right claims. Writing the claims by hand in every test buries what the test is about. So the Starter's Web tests have an `AuthorizationHandlerContextBuilder`, and a test states only what matters to it: `.For(requirement).OnResource(resource).WithSubject(s => s.WithId(userId)).Build()`.

Nat Pryce called this a **test data builder**: sensible defaults, and only the values the test cares about are set. When the context's construction changes, one class changes, not every test.


## When it is too much
A builder is one more class to keep in step with its product. Adding a property means a field, a method and a line in `Build()`. Skip it for a data object with a few properties, where `required` and `init` check at compile time what a builder checks at run time. Skip it for two or three optional parameters, where named arguments read just as well. And if `Build()` validates nothing, defaults nothing and accumulates nothing, it is an object initializer with extra steps.


## References
- [Builder](https://refactoring.guru/design-patterns/builder) — Refactoring.Guru: the pattern with its director role.
- [Required members](https://learn.microsoft.com/dotnet/csharp/language-reference/proposals/csharp-11.0/required-members) — Microsoft Learn: the C# 11 feature that makes many builders unnecessary.
- [Test Data Builders](http://www.natpryce.com/articles/000714.html) — Nat Pryce on builders for tests.
- [A strict Content Security Policy for an Angular SPA](/blog/2026-08-26-strict-content-security-policy-for-an-angular-spa/) — the policy the immutable builder produces.
