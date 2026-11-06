---
templateKey: 'blog-post'
title: 'Introduction to S.O.L.I.D principles'
date: 2022-02-28T18:04:10.000Z
author: Jimmy Boinembalome
authorimage: /img/jimmy.jpg
category: Best Practices
topic: 'Architecture'
illustration: 1
categorycolor: bg-green-100 text-green-800
featuredpost: true
featuredimage: /img/introduction_to_solid_principles.jpg
description: >-
  Let's discover the principles of object-oriented programming to produce a better code with some examples in C#.
tags:
  - Development
  - OOP
  - C#
  - Tips
---

SOLID is an acronym representing five principles of object-oriented programming (OOP) introduced by Robert C. Martin to build solutions easy to maintain, extend and therefore easy to evolve. Knowing these principles can be useful to any developer wishing to improve the quality of their code.

## History of SOLID principles
Robert C. Martin began to group these principles together in the late 1980s, following a number of discussions on software design principles. 
Over the years, software development has evolved and some principles have been added or removed. 
However, the software design principles were finally stabilised in 2000. 

In 2004, Michael Feathers discussed with Robert C. Martin that if he reorganised the principles, the acronym for the principles would be the word SOLID and thus the SOLID principles were born.

## Single Responsibility Principle (SRP)
SRP is the first principle of SOLID and says that:
>A module should be responsible to one, and only one, actor.

This principle means that a coherent set of functions or a class should have only one responsibility.

If our class has multiple responsibilities, there is a risk that our class will be more difficult to maintain and evolve as it will be highly coupled.

**Violation of SRP:**
```csharp
public enum ProductType
{
    Fruit = 0,
    Water = 1,
}
```

```csharp
public class Product
{
    public int Id { get; set; }
    public string Name { get; set; }
    public double Price { get; set; }
    public ProductType Type { get; set; }
}
```

```csharp
public class ProductDatabase
{
    public List<Product> LoadFromMemory()
    {
        productsInMemory = new List<Product>
        {
            new Product { Id = 1, Name = "Apple", Price = 0.5, Type = ProductType.Fruit },
            new Product { Id = 2, Name = "Sparkling Water", Price = 2.5, Type = ProductType.Water }
        };
    }

    public Product GetProduct(int id)
    {
        var products = LoadFromMemory();
        var product = products.FirstOrDefault(p => p.Id == id);
        
        switch (product.Type)
        {
            case ProductType.Fruit:
                Console.WriteLine("Add VAT to the price of Fruit...");
                product.Price *= 1.989;
                break;
            case ProductType.Water:
                Console.WriteLine("Add VAT to the price of Water...");
                product.Price *= 1.154;
                break;
            default:
                Console.WriteLine("Unable to add VAT to the price without the product type.");
                break;
        }

        return product;
    }
}
```

As we can see, `ProductDatabase` has several responsibilities:
- `LoadFromMemory`: Persistence
- `Console.WriteLine`: Logging
- Add Vat to a product: Business Rules 

Each time we need to update one of these responsibilities, we will be forced to modify the `ProductDatabase` class.

A better approach would be to separate these responsibilities.

**Application of SRP:**
```csharp
public class ProductDatabase
{
    public List<Product> LoadFromMemory()
    {
        return new List<Product>
        {
            new Product { Id = 1, Name = "Apple", Price = 0.5, Type = ProductType.Fruit },
            new Product { Id = 2, Name = "Sparkling Water", Price = 2.5, Type = ProductType.Water }
        };
    }
}
```

```csharp
public class ProductRepository
{
    private ProductDatabase Database { get; set; } = new ProductDatabase();

    public Product GetProduct(int id)
    {
        var products = Database.LoadFromMemory();
        var product = products.FirstOrDefault(p => p.Id == id);

        return product;
    }
}
```

```csharp
public class ConsoleLogger
{
    public void Log(string message)
    {
        Console.WriteLine(message);
    }
}
```

```csharp
public class ProductService
{
    public ConsoleLogger Logger { get; set; } = new ConsoleLogger();

    public void AddVatToPrice(Product product)
    {
        switch (product.Type)
        {
            case ProductType.Fruit:
                Logger.Log("Add VAT to the price of Fruit...");
                product.Price *= 1.989;
                break;
            case ProductType.Water:
                Logger.Log("Add VAT to the price of Water...");
                product.Price *= 1.154;
                break;
            default:
                Logger.Log("Unable to add VAT to the price without the product type.");
                break;
        }
    }
}
```

With this solution, we obtain a low coupling and a high cohesion.

## Open Closed Principle (OCP)

>A software artifact should be open for extension but closed for modification. 

OCP means that it should be possible to change the behavior of a method without having to edit its source code. 

Let's see the `AddVatToPrice` method.

**Violation of OCP:**
```csharp
public class ProductService
{
    public ConsoleLogger Logger { get; set; } = new ConsoleLogger();

    public void AddVatToPrice(Product product)
    {
        switch (product.Type)
        {
            case ProductType.Fruit:
                Logger.Log("Add VAT to the price of Fruit...");
                product.Price *= 1.989;
                break;
            case ProductType.Water:
                Logger.Log("Add VAT to the price of Water...");
                product.Price *= 1.154;
                break;
            default:
                Logger.Log("Unable to add VAT to the price without the product type.");
                break;
        }
    }
}
```

Now, imagine that we have to add VAT to a new type of product, such as Meat. 

A logical approach would be to add another case in the switch. This approach is good most of the time and for simple functions like here.

However, we will apply OCP in our example to understand why in many cases it can be useful to follow this principle.

There are lots of ways to follow OCP. We can use Polymorphism, Delegates, Strategy Pattern, Abstract Factory Pattern and many others.
 
Let's use the last one, the Abstract Factory Pattern.

**Application of OCP:**

At first, we create a base class for VAT.
 
```csharp
public abstract class Vat
{
    protected readonly ConsoleLogger _logger;

    public Vat(ConsoleLogger logger)
    {
        _logger = logger;
    }

    public abstract void Add(Product product);
}
```

Then we create classes that inherit from this class for each type of VAT.

```csharp
public class FruitVat : Vat
{
    public FruitVat(ConsoleLogger logger)
        : base(logger)
    {
    }

    public override void Add(Product product)
    {
        _logger.Log("Add VAT to the price of Fruit...");
        product.Price *= 1.989;
    }
}
```

```csharp
public class WaterVat : Vat
{
    public WaterVat(ConsoleLogger logger)
        : base(logger)
    {
    }

    public override void Add(Product product)
    {
        _logger.Log("Add VAT to the price of Water...");
        product.Price *= 1.154;
    }
}
```

Now we add our factory which will create the appropriate instance of `Vat` and return an object of type `Vat` (because any class that inherits from `Vat` is a `Vat`).

```csharp
public class VatFactory
{
    public Vat Create(Product product, ConsoleLogger logger)
    {
        return product.Type switch
        {
            ProductType.Fruit => new FruitVat(logger),
            ProductType.Water => new WaterVat(logger),
            _ => null,
        };
    }
}
```
And finally we instantiate the factory in `ProductService`.

```csharp
public class ProductService
{
    public ConsoleLogger Logger { get; set; } = new ConsoleLogger();

    public void AddVatToPrice(Product product)
    {
        Logger.Log($"Price of {product.Name} before adding VAT: {product.Price}");

        var factory = new VatFactory();

        var vat = factory.Create(product, Logger);
        if (vat == null)
            Logger.Log("Unable to add VAT to the price without the product type.");
        else
            vat.Add(product);

        Logger.Log($"Price of {product.Name} after adding VAT: {product.Price}");
    }
}
```

As we can see, now `ProductService` is closed to modification and `VatFactory` is open to extension.

## Liskov Substitution Principle (LSP)

>If for each object o1 of type S there is an object o2 of type T such that for all programs P defined in terms of T, the behaviour of P is unchanged when o1 is substituted for o2 then S is a subtype of T.

A more approachable definition is simply subtypes must be substitutable for their base types.

Regarding our example on the product VAT, we already follow the LSP principle. 
Indeed, `FruitVat`, `WaterVat` inherit from the base class `Vat` and inside our factory we can call `vat.Add` since after all, any type of `Vat` is a `Vat`. 

Therefore, everything is fine? Unfortunately not exactly, we have one case that does not follow the LSP principle.

**Violation of LSP:**

```csharp
public class VatFactory
{
    public Vat Create(Product product, ConsoleLogger logger)
    {
        return product.Type switch
        {
            ProductType.Fruit => new FruitVat(logger),
            ProductType.Water => new WaterVat(logger),
            _ => null,
        };
    }
}
```

```csharp
var vat = factory.Create(product, Logger);
if (vat == null)
    Console.WriteLine("Unable to add VAT to the price without the product type.");
else
    vat.Add(product);
```

Here, when a product is unknown, we cannot add the VAT and an error message is shown. Therefore, we violate the LSP principle because we treat unknown products differently from other product types. 

Let's take another approach that follows LSP.

**Application of LSP:**

```csharp
public class UnknownVat : Vat
{
    public UnknownVat(ConsoleLogger logger)
        : base(logger)
    {
    }

    public override void Add(Product product)
    {
        _logger.Log("Unable to add VAT to the price without the product type.");
    }
}
```

```csharp
public class VatFactory
{
    public Vat Create(Product product, ConsoleLogger logger)
    {
        return product.Type switch
        {
            ProductType.Fruit => new FruitVat(logger),
            ProductType.Water => new WaterVat(logger),
            _ => new UnknownVat(logger),
        };
    }
}
```

```csharp
var vat = factory.Create(product, Logger);
vat.Add(product);
```

## Interface Segregation Principle (ISP)

>A client should never be forced to implement an interface that it doesn’t use or clients shouldn’t be forced to depend on methods they do not use

When you think about it, having an interface with many methods brings a strong coupling. More exactly, all classes that depend on this interface must implement all its methods.

However, what if we only need one or two methods?

One solution is to split this interface into small cohesive interfaces.

Let's look at with an example.

**Violation of ISP:**

We will add a `LoadFromXml` method to the `IProductDatabase` interface because a second application loads products from this source.

```csharp
public interface IProductDatabase
{
    List<Product> LoadFromMemory();
    List<Product> LoadFromXml();
}
```

Since both applications must have consistent code, we use this interface in our application as well.

```csharp
public class ProductDatabase : IProductDatabase
{
    public List<Product> LoadFromMemory()
    {
        ....
    }

    public List<Product> LoadFromXml()
    {
        throw new System.NotImplementedException();
    }
}
```

```csharp
public class ProductRepository
{
    private IProductDatabase Database { get; set; } = new ProductDatabase();

    ....
}
```

As we can see here, we are constrained to have the `LoadFromXml` method which we will not use in our application.

Let's divide this interface.

**Application of ISP:**

```csharp
public interface IMemoryLoad<T> where T : class
{
    List<T> LoadFromMemory();
}
```

```csharp
public interface IXmlLoad<T> where T : class
{
    List<T> LoadFromXml();
}
```

```csharp
public interface IProductDatabase : 
                    IMemoryLoad<Product>, 
                    IXmlLoad<Product>
{
}
```
To avoid breaking the second application, `IProductDatabase` inherits from `IMemoryLoad`, and `IXmlLoad`. This way, `IProductDatabase` will always have to implement the LoadFrom methods for the 2 sources.

On our side we will create another interface that will inherit only from `IMemoryLoad`. (Or we can also use `IMemoryLoad` directly if we are sure to use only this source)

```csharp
public interface IOriginalProductDatabase : 
                    IMemoryLoad
{
}
```

```csharp
public class ProductRepository
{
    private IOriginalProductDatabase Database { get; set; } = new ProductDatabase();

    ....
}
```

```csharp
public class ProductDatabase : IOriginalProductDatabase
{
    ....
}
```

## Dependency Inversion Principle (DIP)

>High-level modules should not depend on low-level modules. Both should depend on abstractions.

>Abstractions should not depend on details. Details should depend on abstractions.

The high-level modules are those that contain the core of the application. This is where we mainly find our business rules and anything that tends to be more abstract. 

On the other side, the low-level modules are those that are related to details. They often concern inputs and outputs. For example, file reader, database querying, logging, sending mail etc.

To keep it simple, DIP means that a class should not depend directly on another class, but rather on an abstraction (e.g an interface) of this class.

Let's go back to the `ProductRepository` example.

**Violation of DIP:**

```csharp
public class ProductRepository
{
    private IOriginalProductDatabase Database { get; set; } = new ProductDatabase();

    ....
}
```

Here, our `ProductRepository` depends on `Database` because we are creating a new instance of `ProductDatabase`.

However, according to the Repository Pattern, a repository is an abstraction that does not depend on the database. 

Therefore, we will reverse this dependency.

**Application of DIP:**
```csharp
class Program
{
    static void Main(string[] args)
    {
        var IOriginalProductDatabase database = new ProductDatabase();
        var productRepository = new ProductRepository(database);
        var products = productRepository.GetProducts();
    }
}
```

```csharp
public class ProductRepository
{
    private readonly IOriginalProductDatabase _database;

    public ProductRepository(IOriginalProductDatabase database)
    {
        _database = database;
    }

    ....
}
```

Now ProductRepository depends on an abstraction. This means that in the future we will not need to modify ProductRepository if we want to replace the database.

## Conclusion

Applying SOLID principles can be beneficial in many cases if we want to build robust software that is easy to maintain and easy to evolve. 
It is also important to remember to apply the SOLID principles according to the context.

For example, for small projects that will not evolve, not following SOLID may be acceptable. It can make the code more complex and ultimately we can spend more time develto develop the solution when it could be simpler.


*Thanks for reading my first article! ❤️*