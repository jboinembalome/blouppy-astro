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
description: Build an API in C# using Clean Architecture principles for maintainable and scalable code.
tags:
  - Development
  - C#
  - Architecture
---

> **Updated November 2026:** the sample now targets .NET 10 and C# 14 (primary constructors, records), and the API no longer accepts the entity as its request body, so a client cannot over-post fields it should not set.

Clean Architecture is a software design principle introduced by **Robert C. Martin**, popularly known as Uncle Bob, in his book "[Clean Architecture: A Craftsman's Guide to Software Structure and Design](https://www.amazon.com/Clean-Architecture-Craftsmans-Software-Structure/dp/0134494164)". It provides a structured and modular approach to building software systems that are flexible, maintainable, and testable. This architectural pattern focuses on separating business logic from infrastructure concerns, enabling developers to create robust and scalable applications.

In this article, we will explore the key concepts of Clean Architecture and demonstrate its implementation in C# using an example of ToDoList API.


## Key Concepts of Clean Architecture
![Clean Architecture](/img/clean-architecture.jpg)
1. **Entities**: Entities encapsulate the business rules and logic of the application. They represent the core of the system and are independent of any specific framework or infrastructure. An entity could be a "TodoItem" object, which includes properties like a title, description, due date, and completion status.

2. **Use Cases**: Use cases represent the application's specific behaviors or features. They encapsulate the application's business rules and orchestrate the interaction between entities and interface adapters. A possible use case could be "CreateTodoItem",  which handles the logic of creating a new task.

3. **Interface Adapters**: Interface adapters convert data from the external world into a format that the use cases and entities can understand, and vice versa. They act as intermediaries between the business logic and the external frameworks or tools. Examples of interface adapters include identity, logging, mail, and repositories.

4. **Frameworks and Drivers**: This layer contains the external tools, frameworks, and infrastructure components used in the application, such as databases, ## Implementing Clean Architecture in C#
Let's now dive into the implementation of Clean Architecture in C# by building a simple ToDoList API with .NET 10. The solution has one project per ring, and references only point inward:

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

First, we will focus on the core components: Entities and Use Cases.

``` csharp
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

In the above code snippet, we have defined the entities and a use case for creating an item in the ToDoList. The `TodoItem` class represents an entity with its properties. The `CreateTodoItemUseCase` class handles the logic for creating an item, relying on an interface `ITodoItemRepository` for persistence. Notice that this interface lives in the application layer: the use case says what it needs, and it does not care who provides it. 😉

> **_Note:_** `CreateTodoItemUseCase(ITodoItemRepository todoItemRepository)` is a primary constructor (C# 12 and later): the parameter is available in the whole class, so there is no need for a private field and a constructor that only assigns it.

Now, let's move on to the interface adapter layer:

``` csharp
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

In the interface adapter layer, we have implemented the `ITodoItemRepository` interface with a `TodoItemRepository` class that interacts with the data source.

> **_Note:_**  In the above implementation, Entity Framework Core 10 is used as the Object-Relational Mapping (ORM) framework, enabling seamless communication with the database. The sample uses the in-memory provider to stay self-contained; swapping it for SQL Server or PostgreSQL only touches this project.

Finally, let's move on to the frameworks and drivers layer. The API does not expose the entity directly: it accepts a request record that only contains what a client is allowed to send, and returns a response record.

``` csharp
// TodoList.Api (Frameworks and Drivers)

namespace TodoList.Api.Dtos.TodoItems;

// What a client may send: no Id, no IsCompleted, so they cannot be over-posted.
public sealed record CreateTodoItemDto(string Title, string? Description, DateTime? DueDate);

public sealed record TodoItemDto(int Id, string Title, string? Description, DateTime? DueDate, bool IsCompleted);

namespace TodoList.Api.Controllers;

public class TodoItemController(
    ICreateTodoItemUseCase createTodoItemUseCase,
    IGetTodoItemByIdUseCase getTodoItemByIdUseCase) : ApiControllerBase
{
    [HttpGet("{id:int}")]
    public async Task<ActionResult<TodoItemDto>> Get(int id, CancellationToken cancellationToken)
    {
        if (id <= 0) return BadRequest();

        var todoItem = await getTodoItemByIdUseCase.Execute(id, cancellationToken);
        if (todoItem is null) return NotFound();

        return todoItem.ToTodoItemDto();
    }

    [HttpPost]
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

In the frameworks and drivers layer, we have the `TodoItemController` class, which acts as a web API controller responsible for handling incoming HTTP requests related to TodoItems. It depends on the `ICreateTodoItemUseCase` and `IGetTodoItemByIdUseCase` interfaces, which are implemented in the use cases layer. `CreatedAtAction(nameof(Get), ...)` points to the `Get` action, so the response carries a `Location` header to the new item.

Why a request record rather than the entity? If the controller accepted `TodoItem`, a client could send `"id"` or `"isCompleted": true` and the model binder would happily set them. With `CreateTodoItemDto`, those fields simply do not exist. Let's try it:

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

The `id` and `isCompleted` sent by the client were ignored. 🙂 And since `Title` is a non-nullable `string`, `[ApiController]` rejects a request without it before the action even runs:

```
HTTP/1.1 400 Bad Request
Content-Type: application/json; charset=utf-8

{"type":"https://tools.ietf.org/html/rfc9110#section-15.5.1","title":"One or more validation errors occurred.","status":400,"errors":{"Title":["The Title field is required."]},"traceId":"00-227f6d27b591166ba32b5a4e9a2172b2-35de9ff882fd3d0b-00"}
```


layer, we have the `TodoItemController` class, which acts as a web API controller responsible for handling incoming HTTP requests related to TodoItems. It depends on the `ICreateTodoItemUseCase` interface, which is implemented in the use cases layer.


## Conclusion
By following the Clean Architecture principles, we have achieved a separation of concerns and a clear modular structure. The business logic is encapsulated within the use cases and entities, independent of any specific framework or infrastructure. The interface adapters handle the communication with external dependencies such as databases, while the frameworks and drivers layer handles the web server and HTTP communication.

This architecture promotes testability, maintainability, and scalability. It allows for easy modification or replacement of individual components without affecting the entire system. Additionally, the use of interfaces and dependency injection enables loose coupling and facilitates unit testing and mocking.

In conclusion, Clean Architecture provides a solid foundation for building robust and maintainable applications by separating concerns and dependencies. By applying these principles, we have demonstrated how to structure the codebase and achieve a clean and scalable architecture.

Source code of the article: [Github source code](https://github.com/jboinembalome/IntroductionToCleanArchitecture)

*Happy coding! 🙂*