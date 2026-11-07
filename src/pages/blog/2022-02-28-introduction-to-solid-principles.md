---
templateKey: 'blog-post'
title: 'Introduction to S.O.L.I.D principles'
date: 2022-02-28T18:04:10.000Z
updated: 2026-11-07T09:00:00.000Z
author: Jimmy Boinembalome
authorimage: /img/jimmy.jpg
category: Best Practices
topic: 'Architecture'
illustration: 1
categorycolor: bg-green-100 text-green-800
featuredpost: true
featuredimage: /img/introduction_to_solid_principles.jpg
description: >-
  The five SOLID principles of object-oriented design, applied one after the other to a single C# example: a product catalog that computes prices with VAT.
tags:
  - Development
  - OOP
  - C#
  - Tips
---

> **Updated November 2026:** the C# samples are now modern C# 14 on .NET 10 and follow one running example from the first principle to the last, with dependency injection at the end. I also fixed a few mistakes that slipped into the first version. The principles themselves have not changed.

SOLID is an acronym for five principles of object-oriented design gathered by Robert C. Martin. They help us write code that is easy to maintain and extend. In this article, we apply them one after the other to the same small C# example.

## History of the SOLID principles
Robert C. Martin started gathering these principles in the late 1980s, in discussions about software design. The list changed over the years, and he published the stable set in his 2000 paper *Design Principles and Design Patterns*. Around 2004, Michael Feathers pointed out that, reordered, their initials spell SOLID, and the name stuck.

## The running example
A shop sells products and must display their price including VAT:

```csharp
public enum ProductType
{
    Fruit,
    Water,
}

public record Product(int Id, string Name, decimal Price, ProductType Type);
```

> **_Note:_** A price is money, so it is a [`decimal`](https://learn.microsoft.com/dotnet/csharp/language-reference/builtin-types/floating-point-numeric-types) rather than a `double`, which cannot represent most decimal amounts exactly.

## Single Responsibility Principle (SRP)
> A module should be responsible to one, and only one, actor.

An actor is a group of people who ask for changes: the accountants, the database administrators, the operations team. Martin also puts it this way: [gather together the things that change for the same reasons](https://blog.cleancoder.com/uncle-bob/2014/05/08/SingleReponsibilityPrinciple.html), and separate those that change for different reasons.

**Violation of SRP:**

```csharp
public class ProductDatabase
{
    private readonly List<Product> _products =
    [
        new(1, "Apple", 0.50m, ProductType.Fruit),
        new(2, "Sparkling water", 2.50m, ProductType.Water),
    ];

    public decimal? GetPriceIncludingVat(int id)
    {
        var product = _products.Find(p => p.Id == id);
        if (product is null)
        {
            Console.WriteLine($"Product {id} not found.");
            return null;
        }

        Console.WriteLine($"Adding VAT to the price of {product.Name}.");

        return product.Type switch
        {
            ProductType.Fruit => product.Price * 1.055m,
            ProductType.Water => product.Price * 1.20m,
            _ => throw new NotSupportedException($"No VAT rule for {product.Type}."),
        };
    }
}
```

`ProductDatabase` answers to three actors:
- the storage of the products (persistence);
- `Console.WriteLine` (logging);
- the VAT rates (business rules).

A change requested by one actor means editing a class the other two depend on.

**Application of SRP:** each responsibility gets its own class.

```csharp
public class ProductRepository
{
    private readonly List<Product> _products =
    [
        new(1, "Apple", 0.50m, ProductType.Fruit),
        new(2, "Sparkling water", 2.50m, ProductType.Water),
    ];

    public Product? GetById(int id) => _products.Find(p => p.Id == id);
}

public class ConsoleLogger
{
    public void Log(string message) => Console.WriteLine(message);
}

public class ProductService
{
    private readonly ProductRepository _repository = new();
    private readonly ConsoleLogger _logger = new();

    public decimal? GetPriceIncludingVat(int id)
    {
        var product = _repository.GetById(id);
        if (product is null)
        {
            _logger.Log($"Product {id} not found.");
            return null;
        }

        _logger.Log($"Adding VAT to the price of {product.Name}.");

        return product.Type switch
        {
            ProductType.Fruit => product.Price * 1.055m,
            ProductType.Water => product.Price * 1.20m,
            _ => throw new NotSupportedException($"No VAT rule for {product.Type}."),
        };
    }
}
```

Each class now has one reason to change: low coupling, high cohesion.

## Open-Closed Principle (OCP)
> A software artifact should be open for extension but closed for modification.

We should be able to add a behaviour without editing code that already works. The `switch` in `ProductService` breaks this rule: to sell meat, we must modify `GetPriceIncludingVat`. For a switch this small, adding a case is often fine, but the pattern shows why OCP matters as rules multiply.

Polymorphism, delegates and the Strategy pattern all help. Here, we use polymorphism with a simple factory (not the Gang of Four's Abstract Factory: one class just picks the right subclass).

**Application of OCP:**

```csharp
public abstract class Vat
{
    public abstract decimal Apply(decimal price);
}

public sealed class FruitVat : Vat
{
    public override decimal Apply(decimal price) => price * 1.055m;
}

public sealed class WaterVat : Vat
{
    public override decimal Apply(decimal price) => price * 1.20m;
}

public class VatFactory
{
    public Vat Create(ProductType type) => type switch
    {
        ProductType.Fruit => new FruitVat(),
        ProductType.Water => new WaterVat(),
        _ => throw new NotSupportedException($"No VAT rule for {type}."),
    };
}
```

`ProductService` gets a `VatFactory _vatFactory = new();` field, and its `switch` becomes:

```csharp
var vat = _vatFactory.Create(product.Type);
return vat.Apply(product.Price);
```

`ProductService` is now closed for modification: to support meat, we add a `MeatVat` class and one line in `VatFactory`, and `ProductService` does not change.

## Liskov Substitution Principle (LSP)
> If for each object o1 of type S there is an object o2 of type T such that for all programs P defined in terms of T, the behavior of P is unchanged when o1 is substituted for o2 then S is a subtype of T.

This definition comes from [Barbara Liskov](https://en.wikipedia.org/wiki/Liskov_substitution_principle) (1988). Put simply: subtypes must be substitutable for their base types. Code that works with a `Vat` must work with any subclass of `Vat`, without knowing which one it has.

**Violation of LSP:** the shop now sells gift cards, which carry no VAT. We add `GiftCard` to `ProductType`, a line to the factory (`ProductType.GiftCard => new GiftCardVat(),`) and this class:

```csharp
public sealed class GiftCardVat : Vat
{
    public override decimal Apply(decimal price) =>
        throw new NotSupportedException("Gift cards are not subject to VAT.");
}
```

`GiftCardVat` refuses what every `Vat` promises: to return the price including VAT. `ProductService` must now know about this one subclass:

```csharp
var vat = _vatFactory.Create(product.Type);
return vat is GiftCardVat ? product.Price : vat.Apply(product.Price);
```

A type check on a subclass is the typical sign of an LSP violation, and it breaks OCP again.

**Application of LSP:** `GiftCardVat` keeps the contract. The price including VAT of a gift card is its price:

```csharp
public sealed class GiftCardVat : Vat
{
    public override decimal Apply(decimal price) => price;
}
```

`ProductService` goes back to `return vat.Apply(product.Price);` and treats every product the same way.

## Interface Segregation Principle (ISP)
> Clients should not be forced to depend upon interfaces that they do not use.

**Violation of ISP:** the back office now adds and removes products, so we extract one interface for every use of the repository:

```csharp
public interface IProductRepository
{
    Product? GetById(int id);
    IReadOnlyList<Product> GetAll();
    void Add(Product product);
    void Remove(int id);
}
```

`ProductService` only reads, yet it now depends on `Add` and `Remove` as well. Worse, a read-only source, such as a price list imported from a supplier, is forced to implement methods it cannot support:

```csharp
public class PriceListRepository(IReadOnlyList<Product> priceList) : IProductRepository
{
    public Product? GetById(int id) => priceList.FirstOrDefault(p => p.Id == id);
    public IReadOnlyList<Product> GetAll() => priceList;
    public void Add(Product product) => throw new NotSupportedException();
    public void Remove(int id) => throw new NotSupportedException();
}
```

**Application of ISP:** we split the interface by client.

```csharp
public interface IProductReader
{
    Product? GetById(int id);
    IReadOnlyList<Product> GetAll();
}

public interface IProductWriter
{
    void Add(Product product);
    void Remove(int id);
}
```

`ProductRepository` implements both (`public class ProductRepository : IProductReader, IProductWriter`), `PriceListRepository` implements `IProductReader` only and loses its two `throw` lines, and `ProductService` will only ask for an `IProductReader`.

## Dependency Inversion Principle (DIP)
> High-level modules should not depend on low-level modules. Both should depend on abstractions.
>
> Abstractions should not depend on details. Details should depend on abstractions.

High-level modules hold the business rules, here the price including VAT. Low-level modules hold the details: files, databases, logging, e-mail.

**Violation of DIP:** `ProductService` creates its own `ProductRepository` and `ConsoleLogger` with `new()`. The business rule depends on the details, so we cannot switch to the price list, or test the rule without the real data.

**Application of DIP:** `ProductService` receives abstractions through its [primary constructor](https://learn.microsoft.com/dotnet/csharp/whats-new/tutorials/primary-constructors). Our `ConsoleLogger` gives way to [`ILogger<T>`](https://learn.microsoft.com/dotnet/core/extensions/logging), the logging abstraction of .NET:

```csharp
using Microsoft.Extensions.Logging;

public class ProductService(IProductReader products, VatFactory vatFactory, ILogger<ProductService> logger)
{
    public decimal? GetPriceIncludingVat(int id)
    {
        var product = products.GetById(id);
        if (product is null)
        {
            logger.LogWarning("Product {ProductId} not found.", id);
            return null;
        }

        logger.LogInformation("Adding VAT to the price of {ProductName}.", product.Name);

        return vatFactory.Create(product.Type).Apply(product.Price);
    }
}
```

`VatFactory` stays concrete: it is a business rule, not a detail.

The caller now chooses the implementations. In .NET, we register them in the [dependency injection container](https://learn.microsoft.com/dotnet/core/extensions/dependency-injection) that ASP.NET Core uses (packages `Microsoft.Extensions.DependencyInjection` and `Microsoft.Extensions.Logging.Console` in a console app), here in `Program.cs`:

```csharp
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;

var services = new ServiceCollection();
services.AddLogging(logging => logging.AddConsole());
services.AddSingleton<IProductReader, ProductRepository>();
services.AddSingleton<VatFactory>();
services.AddTransient<ProductService>();

using var provider = services.BuildServiceProvider();

var productService = provider.GetRequiredService<ProductService>();
Console.WriteLine(productService.GetPriceIncludingVat(1)); // 0.52750
```

To read the supplier's price list instead, we change one registration, and `ProductService` does not change. In a unit test, we pass a fake `IProductReader` directly to the constructor.

## Conclusion
The SOLID principles help us build robust software that is easy to maintain and evolve. They are guidelines, not laws: apply them according to the context. On a small project that will not evolve, the extra classes and interfaces can cost more than they save.

## References
- [Architectural principles](https://learn.microsoft.com/dotnet/architecture/modern-web-apps-azure/architectural-principles) — Microsoft Learn: single responsibility, dependency inversion and the other principles in .NET guidance.
- [Dependency injection in .NET](https://learn.microsoft.com/dotnet/core/extensions/dependency-injection) — Microsoft Learn: `ServiceCollection`, service lifetimes and constructor injection.
- [Logging in .NET](https://learn.microsoft.com/dotnet/core/extensions/logging) — Microsoft Learn: `ILogger<T>` and message templates.
- [Primary constructors](https://learn.microsoft.com/dotnet/csharp/whats-new/tutorials/primary-constructors) — Microsoft Learn: the C# 12 syntax used for injection.
- [Clean Architecture](https://www.informit.com/store/clean-architecture-a-craftsmans-guide-to-software-structure-9780134494166) — Robert C. Martin (2017): the history of SOLID and the "actor" and "software artifact" wordings of SRP and OCP.
- [The Single Responsibility Principle](https://blog.cleancoder.com/uncle-bob/2014/05/08/SingleReponsibilityPrinciple.html) — Robert C. Martin: what a "reason to change" means.
- [Solid Relevance](https://blog.cleancoder.com/uncle-bob/2020/10/18/Solid-Relevance.html) — Robert C. Martin: why the principles still apply today.
- [SOLID](https://en.wikipedia.org/wiki/SOLID) — Wikipedia: the 2000 paper and the acronym coined by Michael Feathers.
- [Liskov substitution principle](https://en.wikipedia.org/wiki/Liskov_substitution_principle) — Wikipedia: Barbara Liskov's definition and behavioural subtyping.

*Thanks for reading! 🙂*
