---
templateKey: 'blog-post'
title: 'Introduction to Clean Architecture'
date: 2023-05-28T18:24:10.000Z
updated: 2026-11-07T09:00:00.000Z
author: Jimmy Boinembalome
authorimage: /img/jimmy.jpg
category: C#
topic: 'Architecture'
illustration: 2
categorycolor: bg-purple-100 text-purple-800
featuredpost: true
featuredimage: /img/introduction-to-clean-architecture.jpg
description: Learn the four rings of Clean Architecture and how to apply them in a small .NET 10 Web API, with use cases, a repository port and request records.
tags:
  - Development
  - C#
  - Architecture
---

> **Updated November 2026:** the sample now targets .NET 10 and C# 14 (primary constructors, records), and the API no longer accepts the entity as its request body, so a client cannot over-post fields it should not set.

Clean Architecture is a way of structuring software introduced by **Robert C. Martin** (Uncle Bob) in [a 2012 blog post](https://blog.cleancoder.com/uncle-bob/2012/08/13/the-clean-architecture.html) and later in his book [Clean Architecture: A Craftsman's Guide to Software Structure and Design](https://www.informit.com/store/clean-architecture-a-craftsmans-guide-to-software-structure-9780134494166). It separates business logic from infrastructure, so that the code stays flexible, maintainable and testable.

In this article, we go through its key concepts and apply them to a small ToDoList API in C#.

## Key Concepts of Clean Architecture
![Clean Architecture](/img/clean-architecture.jpg)
1. **Entities** hold the business rules. They are the core of the system and do not depend on any framework or infrastructure. A `TodoItem` with a title, a description, a due date and a completion status is an entity.

2. **Use Cases** implement the application's features. They orchestrate the entities and declare what they need from the outside world. `CreateTodoItem`, which creates a new task, is a use case.

3. **Interface Adapters** convert data between the use cases and the outside world. Repositories, identity, logging and mail are interface adapters.

4. **Frameworks and Drivers** are the external tools: the database, the web framework, the UI.

The rule that ties the rings together is the **dependency rule**: source code dependencies only point inward. An inner ring knows nothing about an outer one.

## Implementing Clean Architecture in C#
The sample is a ToDoList API on .NET 10 with one project per ring. References only point inward:

```
src/
├── Core/
│   ├── TodoList.Domain             (Entities)
│   └── TodoList.Application        (Use Cases)  → TodoList.Domain
├── Infrastructure/
│   └── TodoList.Infrastructure     (Interface Adapters)  → TodoList.Application
└── Presentation/
    └── TodoList.Api                (Frameworks and Drivers)  → TodoList.Infrastructure
```

### Entities and use cases
```csharp
// TodoList.Domain (Entities)

namespace TodoList.Domain.Entities;

public class TodoItem : IEntity<int>
{
    public int Id { get; set; }
    public required string Title { get; set; }
    public string? Description { get; set; }
    public DateTime? DueDate { get; set; }
    public bool IsCompleted { get; set; }
}

// TodoList.Application (Use Cases)

namespace TodoList.Application.Interfaces.Persistence.Repositories;

public interface ITodoItemRepository
{
    Task<TodoItem?> GetByIdAsync(int id, CancellationToken cancellationToken = default);
    Task<TodoItem> AddAsync(TodoItem todoItem, CancellationToken cancellationToken = default);
}

namespace TodoList.Application.UseCases.TodoItems;

public interface ICreateTodoItemUseCase
{
    Task<TodoItem> Execute(TodoItem todoItem, CancellationToken cancellationToken = default);
}

internal sealed class CreateTodoItemUseCase(ITodoItemRepository todoItemRepository) : ICreateTodoItemUseCase
{
    public async Task<TodoItem> Execute(TodoItem todoItem, CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(todoItem);

        // Business logic for creating an item
        return await todoItemRepository.AddAsync(todoItem, cancellationToken);
    }
}
```

`TodoItem` is the entity. `CreateTodoItemUseCase` creates an item and relies on `ITodoItemRepository` for persistence. That interface lives in the application project: the use case states what it needs, not who provides it.

> **_Note:_** `CreateTodoItemUseCase(ITodoItemRepository todoItemRepository)` is a [primary constructor](https://learn.microsoft.com/dotnet/csharp/whats-new/tutorials/primary-constructors) (C# 12 and later). The parameter is in scope in the whole class, so you need neither a private field nor a constructor that assigns it.

### Interface adapters
```csharp
// TodoList.Infrastructure (Interface Adapters)

namespace TodoList.Infrastructure.Persistence.Repositories;

internal sealed class TodoItemRepository(TodoListDbContext dbContext) : ITodoItemRepository
{
    public async Task<TodoItem?> GetByIdAsync(int id, CancellationToken cancellationToken = default) =>
        await dbContext.TodoItems.FindAsync([id], cancellationToken);

    public async Task<TodoItem> AddAsync(TodoItem todoItem, CancellationToken cancellationToken = default)
    {
        await dbContext.TodoItems.AddAsync(todoItem, cancellationToken);
        await dbContext.SaveChangesAsync(cancellationToken);

        return todoItem;
    }
}
```

`TodoItemRepository` implements `ITodoItemRepository` with Entity Framework Core 10. The infrastructure project binds the port to this class with [dependency injection](https://learn.microsoft.com/aspnet/core/fundamentals/dependency-injection) (`AddInfrastructureServices`), as a scoped service like the `DbContext` it uses; the application project registers the use cases the same way (`AddApplicationServices`).

> **_Note:_** To stay self-contained, the sample uses the EF Core [in-memory provider](https://learn.microsoft.com/ef/core/providers/in-memory/), which Microsoft does not recommend outside of tests. Switching to SQL Server or PostgreSQL only touches this project.

### Frameworks and drivers
The API does not expose the entity. It accepts a request record that only contains what a client is allowed to send, and returns a response [record](https://learn.microsoft.com/dotnet/csharp/language-reference/builtin-types/record):

```csharp
// TodoList.Api (Frameworks and Drivers)

namespace TodoList.Api.Dtos.TodoItems;

// What a client may send: no Id, no IsCompleted, so they cannot be over-posted.
public sealed record CreateTodoItemDto(string Title, string? Description, DateTime? DueDate);

public sealed record TodoItemDto(int Id, string Title, string? Description, DateTime? DueDate, bool IsCompleted);

namespace TodoList.Api.Controllers;

public sealed class TodoItemController(
    ICreateTodoItemUseCase createTodoItemUseCase,
    IGetTodoItemByIdUseCase getTodoItemByIdUseCase) : ApiControllerBase
{
    [HttpGet("{id:int}")]
    [ProducesResponseType(StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status400BadRequest)]
    [ProducesResponseType(StatusCodes.Status404NotFound)]
    public async Task<ActionResult<TodoItemDto>> Get(int id, CancellationToken cancellationToken)
    {
        if (id <= 0) return BadRequest();

        var todoItem = await getTodoItemByIdUseCase.Execute(id, cancellationToken);
        if (todoItem is null) return NotFound();

        return todoItem.ToTodoItemDto();
    }

    [HttpPost]
    [ProducesResponseType(StatusCodes.Status201Created)]
    [ProducesResponseType(StatusCodes.Status400BadRequest)]
    public async Task<ActionResult<TodoItemDto>> Create(CreateTodoItemDto createTodoItemDto, CancellationToken cancellationToken)
    {
        if (string.IsNullOrWhiteSpace(createTodoItemDto.Title)) return BadRequest();

        var todoItem = createTodoItemDto.ToTodoItem();
        var createdTodoItem = await createTodoItemUseCase.Execute(todoItem, cancellationToken);

        var dto = createdTodoItem.ToTodoItemDto();
        return CreatedAtAction(nameof(Get), new { id = dto.Id }, dto);
    }
}
```

`TodoItemController` handles the HTTP requests and depends only on the use case interfaces. `ApiControllerBase` carries `[ApiController]` and the `api/[controller]` route. A few details:
- [`CreatedAtAction(nameof(Get), ...)`](https://learn.microsoft.com/aspnet/core/web-api/action-return-types) adds a `Location` header that points to the new item.
- `[ProducesResponseType]` lists every status code in the [OpenAPI document](https://learn.microsoft.com/aspnet/core/fundamentals/openapi/aspnetcore-openapi) that `Microsoft.AspNetCore.OpenApi` serves at `/openapi/v1.json`.
- The `CancellationToken` parameter is bound to the request's cancellation and passed down to EF Core, so an aborted request stops its database work.

**Program.cs** wires the rings together and returns [problem details](https://learn.microsoft.com/aspnet/core/fundamentals/error-handling-api) for every error, including an unhandled exception or an unknown route:

```csharp
builder.Services.AddApplicationServices();
builder.Services.AddInfrastructureServices();

builder.Services.AddControllers();
builder.Services.AddProblemDetails();
builder.Services.AddOpenApi();

var app = builder.Build();

app.UseExceptionHandler();
app.UseStatusCodePages();
```

### Why a request record?
If the controller accepted `TodoItem`, a client could send `"id"` or `"isCompleted": true` and the [model binder](https://learn.microsoft.com/aspnet/core/mvc/models/model-binding) would set them. This is [mass assignment](https://cheatsheetseries.owasp.org/cheatsheets/Mass_Assignment_Cheat_Sheet.html). With `CreateTodoItemDto`, those fields do not exist:

```bash
curl -i -X POST http://localhost:5041/api/TodoItem \
  -H 'Content-Type: application/json' \
  -d '{"title":"Write the article","description":"Clean Architecture in C#","dueDate":"2026-11-30T00:00:00","id":42,"isCompleted":true}'
```

```
HTTP/1.1 201 Created
Content-Type: application/json; charset=utf-8
Location: http://localhost:5041/api/TodoItem/1

{"id":1,"title":"Write the article","description":"Clean Architecture in C#","dueDate":"2026-11-30T00:00:00","isCompleted":false}
```

The API ignored the `id` and `isCompleted` sent by the client. And because `Title` is a non-nullable `string`, `[ApiController]` [rejects a request without it](https://learn.microsoft.com/aspnet/core/mvc/models/validation) before the action runs:

```
HTTP/1.1 400 Bad Request
Content-Type: application/json; charset=utf-8

{"type":"https://tools.ietf.org/html/rfc9110#section-15.5.1","title":"One or more validation errors occurred.","status":400,"errors":{"Title":["The Title field is required."]},"traceId":"00-b3e997a6fb75da84812d4af99ca990b6-9050338791df07b2-00"}
```

> **_Note:_** That implicit check behaves like `[Required(AllowEmptyStrings = true)]`: it rejects a missing title but accepts `""` or `"   "`. This is why the action still tests `string.IsNullOrWhiteSpace`.

## Conclusion
Clean Architecture keeps the business logic in the entities and use cases, independent of any framework. The interface adapters handle external dependencies such as the database, and the outer ring handles HTTP. Because each ring depends only on interfaces declared further in, you can replace a component, or mock it in a unit test, without touching the rest of the system.

Source code of the article: [GitHub source code](https://github.com/jboinembalome/IntroductionToCleanArchitecture)

## References
- [Common web application architectures](https://learn.microsoft.com/dotnet/architecture/modern-web-apps-azure/common-web-application-architectures) — Microsoft's guide to Clean Architecture in ASP.NET Core.
- [Create web APIs with ASP.NET Core](https://learn.microsoft.com/aspnet/core/web-api/) — controllers and the `[ApiController]` attribute.
- [Controller action return types](https://learn.microsoft.com/aspnet/core/web-api/action-return-types) — `ActionResult<T>` and `CreatedAtAction`.
- [Model validation](https://learn.microsoft.com/aspnet/core/mvc/models/validation) — automatic 400 responses and non-nullable reference types.
- [Handle errors in ASP.NET Core APIs](https://learn.microsoft.com/aspnet/core/fundamentals/error-handling-api) — `AddProblemDetails`, the exception handler and status code pages.
- [Generate OpenAPI documents](https://learn.microsoft.com/aspnet/core/fundamentals/openapi/aspnetcore-openapi) — the built-in `Microsoft.AspNetCore.OpenApi` package.
- [Dependency injection in ASP.NET Core](https://learn.microsoft.com/aspnet/core/fundamentals/dependency-injection) — service lifetimes and registration.
- [EF Core in-memory database provider](https://learn.microsoft.com/ef/core/providers/in-memory/) — what the provider is for, and its limits.
- [Primary constructors](https://learn.microsoft.com/dotnet/csharp/whats-new/tutorials/primary-constructors) and [records](https://learn.microsoft.com/dotnet/csharp/language-reference/builtin-types/record) — the C# features used in the sample.
- [OWASP Mass Assignment Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Mass_Assignment_Cheat_Sheet.html) — why an API should not bind its entities.
- [The Clean Architecture](https://blog.cleancoder.com/uncle-bob/2012/08/13/the-clean-architecture.html) — Robert C. Martin's original post.
- [Clean Architecture: A Craftsman's Guide to Software Structure and Design](https://www.informit.com/store/clean-architecture-a-craftsmans-guide-to-software-structure-9780134494166) — the book.
