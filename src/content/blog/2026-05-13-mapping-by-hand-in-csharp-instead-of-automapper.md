---
templateKey: 'blog-post'
title: 'Mapping by hand in C#: extension methods instead of AutoMapper'
date: 2026-05-13T09:00:00.000Z
author: Jimmy Boinembalome
authorimage: /img/jimmy.jpg
category: C#
topic: 'C# & .NET'
illustration: 2
categorycolor: bg-purple-100 text-purple-800
featuredpost: true
description: >-
  Learn how to replace AutoMapper with plain static mappers and extension methods in C#, where mapping belongs in a hexagonal app, and when a library like Mapperly still pays off.
tags:
  - Development
  - C#
  - ASP.NET Core
  - Architecture
---

Most ASP.NET Core projects reach for a mapping library on day one. A controller returns a `ProductDto`, the domain has a `Product`, and copying ten properties by hand feels like a waste. So we add AutoMapper, write a profile and call `mapper.Map<ProductDto>(product)`. A year later, a property renamed in the domain shows up as `null` in the API, and nobody notices until a client does.


## What a convention hides
AutoMapper maps by convention: properties with the same name are copied, and a profile describes the exceptions. On a large model with many look-alike classes, that saves a lot of typing. The cost comes back later.

A destination property with no source is not a compile error. It stays at its default, or fails when someone calls `AssertConfigurationIsValid()` in a test. A `MapFrom` or a value resolver is business logic living in a profile, and "Find all references" on a domain property does not show where it ends up. When a value is wrong, the debugger steps into expression trees compiled at runtime.

Since 2025 there is also a licence question. AutoMapper and MediatR moved to a commercial licence under Lucky Penny Software, with a free tier for some users. For an application, that is a purchase decision. For a template other people deploy, it is a question handed to every user.


## A mapper is a function
A mapping is a pure function from one type to another, and C# has a good way to write one: a static method. When it reads better at the call site, make it an extension. With C# 14, extension members can be grouped in an `extension` block:

```csharp
internal static class ProductMapper
{
    extension(Product product)
    {
        public ProductDto MapToDto()
            => new(
                Id: product.Id.Value,
                Name: product.Name,
                Price: product.Price);
    }
}

var dto = product.MapToDto();
```

No package, no registration, no profile. "Go to definition" lands on the line that builds the DTO, and the debugger steps through it like any other method. The mapper is also where a strongly-typed ID is unwrapped (`product.Id.Value`), so the JSON never sees a `ProductId` and the domain never sees a bare `int`.


## Let the compiler check it
Hand mapping is only safer than conventions if a forgotten property breaks the build. Two C# features make sure it does:

- A **positional record**: every constructor parameter must be passed. Add `string Description` to `ProductDto` and every `new ProductDto(...)` that omits it fails to compile.
- A **`required` member**: an object initializer that does not set it is a compile error (CS9035).

Both have the same hole: a default value. A parameter declared `string? Description = null` can be forgotten silently. Keep defaults for values that are really optional.

The compiler does not catch everything. `Name = source.Description` compiles when both are strings. Named arguments help a reviewer, and a test helps where a mapper holds logic: a currency turned into its ISO code, an enum turned into a wire name. A mapper that copies five properties needs no test of its own; an integration test on the endpoint checks the values.


## When a mapper needs data
[Blouppy Starter](https://starter.blouppy.com/) has no mapping library. Every mapper is a hand-written static class next to its controller, in the Web project. In a [hexagonal architecture](/blog/2026-05-04-hexagonal-architecture-in-dotnet/), that is where the DTO belongs: the domain returns a `Workspace`, and the HTTP adapter turns it into what its clients read.

Sometimes the copy is not enough. A workspace holds an `OwnerId`, but the owner's name and avatar belong to another domain. A static method should not fetch them: a mapper that calls a database is no longer a pure function. So the Starter adds a **DTO factory**, a scoped service, for the part that needs I/O:

```csharp
internal sealed class WorkspaceDtoFactory(IUsersApiQueryService usersApiQueryService) : IWorkspaceDtoFactory
{
    public async Task<WorkspaceDto> CreateAsync(Workspace workspace, CancellationToken cancellationToken)
    {
        var workspaceDto = WorkspaceMapper.MapToDto(workspace);

        var owner = await usersApiQueryService.GetAsync(new UserId(workspace.OwnerId.Value), cancellationToken);

        return workspaceDto with { Owner = UserMapper.MapToDto(owner) };
    }
}
```

The overload for a list maps every workspace, then fetches all the owners in one call. That is exactly the decision a mapping library hides: whether fifty workspaces cost one query or fifty. Most mappers stay static; only a handful, such as workspaces, teams and members, need a factory.


## Mapperly, and when a library pays off
[Mapperly](https://mapperly.riok.app/) is a source generator. You declare a `partial` method on a class marked `[Mapper]`, and it writes the mapping code at compile time. There is no reflection, the generated code can be read and debugged, and a target member it cannot map is a warning, so `TreatWarningsAsErrors` fails the build. It is Apache 2.0 licensed. The mapping is still written by convention, though: renames and conversions go in attributes.

A library still pays off with dozens of large DTOs that mirror their entities one to one, or with hundreds of AutoMapper profiles that already work. For a typical API, where entities do not map one to one and some DTOs need data from elsewhere, plain methods are enough.


## References
- [Mapperly](https://mapperly.riok.app/) — the source-generated object mapper.
- [Extension members](https://learn.microsoft.com/dotnet/csharp/programming-guide/classes-and-structs/extension-methods) — Microsoft Learn: extension methods and the C# 14 `extension` blocks.
- [Required members](https://learn.microsoft.com/dotnet/csharp/language-reference/keywords/required) — Microsoft Learn: the `required` modifier and CS9035.
- [Lucky Penny Software](https://luckypennysoftware.com/) — the company behind the commercial versions of AutoMapper and MediatR.
