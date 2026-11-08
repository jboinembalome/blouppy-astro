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

Most ASP.NET Core projects reach for a mapping library on day one. A controller returns a `WorkspaceDto`, the domain has a `Workspace`, and copying ten properties by hand feels like a waste. So we add AutoMapper, write a profile, call `mapper.Map<WorkspaceDto>(workspace)` and move on. A year later, a property renamed in the domain shows up as `null` in the API, and nobody notices until a client does.

In this article, we will look at what AutoMapper gives and what it costs, write mappings by hand with static mappers and C# 14 extension blocks, see where those mappers live in a [hexagonal architecture](/blog/2026-05-04-hexagonal-architecture-in-dotnet/), and finish with Mapperly, the source-generated middle ground, and the cases where a library is still the better choice.


## What AutoMapper gives
AutoMapper maps by convention. Properties with the same name are copied, `Owner.Name` flattens into `OwnerName`, and collections are mapped element by element. We describe the exceptions in a profile:

```csharp
public sealed class WorkspaceProfile : Profile
{
    public WorkspaceProfile()
    {
        CreateMap<Workspace, WorkspaceDto>()
            .ForMember(dto => dto.Id, options => options.MapFrom(workspace => workspace.Id.Value));
    }
}
```

On a large model with many look-alike classes, that saves a lot of typing. `ProjectTo<T>()` also translates a mapping into an EF Core `Select`, so only the needed columns are read.


## What it costs
The typing it saves is moved somewhere else, and it comes back in four ways.

- **Errors at runtime.** A destination property with no source is not a compile error. It stays at its default value, or throws when the configuration is validated. `AssertConfigurationIsValid()` in a unit test catches the unmapped members, but only if someone wrote that test and only for the maps it covers.
- **Hidden logic.** A `MapFrom`, a value resolver or a type converter is business logic living in a profile. "Find all references" on a domain property does not show where it ends up in the API.
- **Profiles to maintain.** Every pair of types needs a `CreateMap`, registered at startup through assembly scanning. The configuration is a second model of the same classes.
- **Debugging.** When a value is wrong, we step into expression trees compiled at runtime instead of a line of our own code.

And since 2025, a licence question. AutoMapper and MediatR, both by Jimmy Bogard, moved to a commercial licence under Lucky Penny Software, with a free tier for some users. Earlier versions keep their original open-source licence, but staying on them means staying off new releases. For an application, it is a purchase decision. For a template that other people deploy, it is a question handed to every user.


## The idea: a mapper is a function
A mapping is a pure function from one type to another. C# has a good way to write a function: a static method.

```csharp
namespace Shop.Web.Products;

internal static class ProductMapper
{
    public static ProductDto MapToDto(Product product)
        => new(
            Id: product.Id.Value,
            Name: product.Name,
            Price: product.Price);

    public static IReadOnlyCollection<ProductDto> MapToDtos(IReadOnlyCollection<Product> products)
        => products
            .Select(MapToDto)
            .ToArray();
}
```

Or, when it reads better at the call site, an extension method. With C# 14 we can group extension members in an `extension` block:

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

No package, no registration, no profile. "Go to definition" on `MapToDto` lands on the line that builds the DTO, and the debugger steps through it like any other method.


## Let the compiler check the mapping
Hand mapping is only safer than conventions if a forgotten property breaks the build. Two C# features make sure it does:

- A **positional record**: every constructor parameter must be passed. Add `string Description` to the record and every `new ProductDto(...)` that omits it fails to compile.
- A **`required` member**: an object initializer that does not set it is a compile error (CS9035).

Both checks have the same hole: a default value. A positional parameter declared `string? Description = null` can be forgotten silently, and so can a property that is not `required`. Keep defaults for values that are genuinely optional, and prefer `required` on every DTO property a mapper must fill.


## The real example: Blouppy Starter
[Blouppy Starter](https://starter.blouppy.com/) has no mapping library: `Directory.Packages.props` lists no AutoMapper, Mapster or Mapperly package. Every mapper is a hand-written class next to its controller, in `Blouppy.Web/Controllers/Api/<Feature>/`.

That location is the point. In a hexagonal design, the DTO is the HTTP adapter's concern. The domain returns its own `Workspace`, and the Web, the driving adapter, turns it into whatever its clients read. Mapping goes both ways in the same class: a request DTO into the driving port's input record, a domain entity into a response DTO.

```csharp
namespace Blouppy.Web.Controllers.Api.Workspaces;

internal static class WorkspaceMapper
{
    public static WorkspaceEdition MapToEdition(WorkspaceEditionDto editionDto)
        => new(
            Id: new WorkspaceId(editionDto.Id),
            Name: editionDto.Name,
            Colour: editionDto.Colour,
            Description: editionDto.Description);

    public static WorkspaceDto MapToDto(Workspace workspace)
        => new(
            Id: workspace.Id.Value,
            Name: workspace.Name,
            Colour: workspace.Colour,
            Owner: new UserDto
            {
                Id = workspace.OwnerId.Value
            },
            OrganizationId: workspace.OrganizationId.Value,
            Description: workspace.Description);
}
```

The mapper is also where strongly-typed IDs are wrapped and unwrapped: `new WorkspaceId(editionDto.Id)` on the way in, `workspace.Id.Value` on the way out. The domain never sees a bare `int`, and the JSON never sees a `WorkspaceId`.

Small value objects use the extension form, so they read naturally inside other mappers:

```csharp
namespace Blouppy.Web.Controllers.Api.Common;

internal static class AmountMapper
{
    extension(Amount amount)
    {
        public AmountDto MapToDto()
            => new()
            {
                Value = amount.Value,
                Currency = amount.Currency.Value
            };
    }
}
```

The billing plan mapper then writes `MonthlyAmount = plan.MonthlyAmount.MapToDto()`.


## When a mapper needs data: a factory
Look again at `WorkspaceMapper.MapToDto`. The owner is a `UserDto` with only its `Id`: a `Workspace` holds an `OwnerId`, and the user's name, e-mail and avatar belong to another domain. A static method cannot fetch them, and it should not try: a mapper that calls a database is no longer a pure function.

So the Starter splits the two jobs. The static mapper does the copying, and a **DTO factory**, a scoped service registered in DI, adds what needs I/O:

```csharp
namespace Blouppy.Web.Controllers.Api.Workspaces;

internal sealed class WorkspaceDtoFactory(
    IUsersApiQueryService usersApiQueryService) : IWorkspaceDtoFactory
{
    public async Task<WorkspaceDto> CreateAsync(
        Workspace workspace,
        CancellationToken cancellationToken = default)
    {
        var workspaceDto = WorkspaceMapper.MapToDto(workspace);

        var owner = await usersApiQueryService.GetAsync(new UserId(workspace.OwnerId.Value), cancellationToken);

        return workspaceDto with
        {
            Owner = UserMapper.MapToDto(owner)
        };
    }
}
```

The collection overload does not call the query service once per workspace. It maps every workspace, fetches all the owners in one call, and fills the owner DTOs from a dictionary keyed by `UserId`. That is exactly the kind of decision a mapping library hides from us: whether a list of fifty workspaces costs one query or fifty.

The rule of thumb in the code base is simple:

- **Static mapper** when everything the DTO needs is in the source object. Most mappers are this.
- **Factory** when the DTO needs data from elsewhere, so the method is `async` and takes a dependency. There are a handful: workspaces, teams, organizations, members, invitations.

The controller then reads like a sequence of steps, mapper in, service, factory out:

```csharp
var workspaceEdition = WorkspaceMapper.MapToEdition(workspaceEditionDto);

var result = await workspacesService.TryUpdateAsync(workspaceEdition, cancellationToken);

// on success
var dto = await workspaceDtoFactory.CreateAsync(workspace, cancellationToken);
```


## Testing mappers, or not
A mapper that copies five properties does not need a test of its own: the compiler checks the shape, and an integration test on the endpoint checks the values. The Starter still tests a fair number of them in `Blouppy.Web.UnitTests`, and the ones that earn it have logic: a currency turned into its ISO code, a page size clamped, an enum turned into a wire name.

```csharp
[Fact]
public void Should_map_Amount_to_AmountDto()
{
    // Arrange
    var amount = new Amount(9.99m, Currency.Usd);

    // Act
    var amountDto = amount.MapToDto();

    // Assert
    var expectedAmountDto = new AmountDto
    {
        Value = 9.99m,
        Currency = "USD"
    };

    amountDto
        .Should()
        .BeEquivalentTo(expectedAmountDto);
}
```

The expected object is typed, not anonymous. With `BeEquivalentTo` against a `new { Value = 9.99m }`, a property added to `AmountDto` later would go unchecked. With a typed expectation, the compiler and the assertion both see it.


## Pitfalls of mapping by hand
Hand mapping has its own failure modes.

- **Defaults and `null!`.** `WorkspaceMapper.MapToCreation` passes `OwnerId: null!` because the service fills the owner from the current user. It works, but `null!` silences exactly the check we rely on. Keep it rare and obvious.
- **Two properties of the same type.** The compiler does not notice `Name = source.Description` when both are strings. Named arguments help a reviewer, and a test helps for the mappers where it matters.
- **Mutation.** The Starter's `UserMapper.MapUserDtos` fills existing `UserDto` instances in place, which is why `UserDto` has setters. That is efficient for the batch case, but it means the DTO is not immutable. Prefer `with` expressions when the volume does not justify it.
- **Logic creeping in.** A mapper is the easiest place to add "just one rule". If a mapping starts deciding things, the decision belongs in the domain.


## Mapperly, the middle ground
[Mapperly](https://mapperly.riok.app/) is a source generator. We declare a partial method, and it writes the mapping code at compile time:

```csharp
[Mapper]
internal static partial class ProductMapper
{
    public static partial ProductDto MapToDto(Product product);
}
```

There is no reflection at runtime and the generated code can be read and debugged like our own. A target member it cannot map is reported as a compiler warning, so with `TreatWarningsAsErrors` it fails the build. It is Apache 2.0 licensed. The trade-off is that the mapping is still written by convention: renames and conversions go in attributes or in hand-written methods it calls, and someone reading the mapper has to know how the generator resolves names.


## When a library still pays off
Hand mapping is not always the right call.

- **Many large, look-alike types**, such as a reporting API with dozens of DTOs of thirty columns that mirror the entities one to one. Mapperly removes the typing without hiding errors.
- **Projections in queries.** `ProjectTo` builds the `Select` for us. Hand-written projections work too, as an `Expression<Func<T, TDto>>`, but they are more code.
- **An existing code base with hundreds of profiles that work.** Rewriting them all has a cost of its own. The licence may be a reason to move, but a gradual move, one feature at a time, is usually enough.

For a typical API with entities that do not map one to one and DTOs that need data from elsewhere, plain methods are enough.


## Conclusion
A mapper is a function, and C# already has functions. Static mappers and extension blocks next to the controllers keep the mapping in the HTTP adapter, where the DTO belongs, make it visible to "find all references" and the debugger, and let positional records and `required` members turn a forgotten property into a build error. Split the pure copy from what needs I/O with a factory, test the mappers that hold logic, and reach for Mapperly when the volume of look-alike types justifies a generator.


## References
- [AutoMapper documentation](https://docs.automapper.io/) — profiles, configuration validation and `ProjectTo`.
- [Lucky Penny Software](https://luckypennysoftware.com/) — the company behind the commercial versions of AutoMapper and MediatR.
- [Mapperly](https://mapperly.riok.app/) — the source-generated object mapper.
- [Extension members](https://learn.microsoft.com/dotnet/csharp/programming-guide/classes-and-structs/extension-methods) — extension methods and the C# 14 `extension` blocks.
- [Required members](https://learn.microsoft.com/dotnet/csharp/language-reference/keywords/required) — the `required` modifier and the CS9035 error.
- [Records](https://learn.microsoft.com/dotnet/csharp/language-reference/builtin-types/record) — positional records and `with` expressions.
- [Blouppy Starter](https://starter.blouppy.com/) — the SaaS starter kit the examples come from.
