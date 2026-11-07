---
templateKey: 'blog-post'
title: 'Introduction to Clean Architecture'
date: 2023-05-28T18:24:10.000Z
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
  
Clean Architecture is a software design principle introduced by **Robert C. Martin**, popularly known as Uncle Bob, in his book "[Clean Architecture: A Craftsman's Guide to Software Structure and Design](https://www.amazon.com/Clean-Architecture-Craftsmans-Software-Structure/dp/0134494164)". It provides a structured and modular approach to building software systems that are flexible, maintainable, and testable. This architectural pattern focuses on separating business logic from infrastructure concerns, enabling developers to create robust and scalable applications.

In this article, we will explore the key concepts of Clean Architecture and demonstrate its implementation in C# using an example of ToDoList API.


## Key Concepts of Clean Architecture
![Clean Architecture](/img/clean-architecture.jpg)
1. **Entities**: Entities encapsulate the business rules and logic of the application. They represent the core of the system and are independent of any specific framework or infrastructure. An entity could be a "TodoItem" object, which includes properties like a title, description, due date, and completion status.

2. **Use Cases**: Use cases represent the application's specific behaviors or features. They encapsulate the application's business rules and orchestrate the interaction between entities and interface adapters. A possible use case could be "CreateTodoItem",  which handles the logic of creating a new task.

3. **Interface Adapters**: Interface adapters convert data from the external world into a format that the use cases and entities can understand, and vice versa. They act as intermediaries between the business logic and the external frameworks or tools. Examples of interface adapters include identity, logging, mail, and repositories.

4. **Frameworks and Drivers**: This layer contains the external tools, frameworks, and infrastructure components used in the application, such as databases, web servers, or user interface frameworks. In our context, the API needs a web server to handle incoming HTTP requests and route them to the appropriate endpoints. As we will use the ASP.NET Web API, the web server is provided by the ASP.NET runtime.


## Implementing Clean Architecture in C#
Let's now dive into the implementation of Clean Architecture in C# by building a simple ToDoList API. First, we will focus on the core components: Entities and Use Cases.

``` csharp
// TodoList.Domain (Entities)

namespace TodoList.Domain.Entities;

public class TodoItem
{
    public int Id { get; set; }
    public required string Title { get; set; }
    public string? Description { get; set; }
    public DateTime? DueDate { get; set; }
    public bool IsCompleted { get; set; }
}

// TodoList.Application (Use Cases)

namespace TodoList.Application.UseCases.TodoItems;

public interface ITodoItemRepository
{
    Task<TodoItem> AddAsync(TodoItem todoItem, CancellationToken cancellationToken = default);
}

public interface ICreateTodoItemUseCase
{
    Task<TodoItem> Execute(TodoItem todoItem, CancellationToken cancellationToken = default);
}

internal class CreateTodoItemUseCase : ICreateTodoItemUseCase
{
    private readonly ITodoItemRepository _todoItemRepository;

    public CreateTodoItemUseCase(ITodoItemRepository todoItemRepository)
    {
        _todoItemRepository = todoItemRepository;
    }

    public async Task<TodoItem> Execute(TodoItem todoItem, CancellationToken cancellationToken = default)
    {
        // Business logic for creating an item
        _ = await _todoItemRepository.AddAsync(todoItem, cancellationToken);

        return todoItem;
    }
}

```

In the above code snippet, we have defined the entities and a use case for creating an item in the ToDoList. The TodoItem class represents an entity with its properties. The CreateTodoItemUseCase class handles the logic for creating an item, relying on an interface ITaskRepository for persistence.

Now, let's move on to the interface adapter layer:

``` csharp
// TodoList.Infrastructure (Interface Adapters)

namespace TodoList.Infrastructure.Persistence.Repositories;

internal class TodoItemRepository : ITodoItemRepository
{
    private readonly TodoListDbContext _dbContext;

    public TodoItemRepository(TodoListDbContext dbContext)
    {
        _dbContext = dbContext;
    }

    public async Task<TodoItem> AddAsync(TodoItem todoItem, CancellationToken cancellationToken = default)
    {
        await _dbContext.TodoItems.AddAsync(todoItem, cancellationToken);
        await _dbContext.SaveChangesAsync(cancellationToken);

        return todoItem;
    }
}
```

In the interface adapter layer, we have implemented the `ITodoItemRepository` interface with a `TodoItemRepository` class that interacts with the data source.

> **_Note:_**  In the above implementation, Entity Framework Core is used as the Object-Relational Mapping (ORM) framework, enabling seamless communication with the database.

Finally, let's move on to the frameworks and drivers layer:

``` csharp
// TodoList.Api (Frameworks and Drivers)

namespace TodoList.Api.Controllers;

public class TodoItemController : ApiControllerBase
{
    private readonly ICreateTodoItemUseCase _createTodoItemUseCase;

    public TodoItemController(ICreateTodoItemUseCase createTodoItemUseCase)
    {
        _createTodoItemUseCase = createTodoItemUseCase;
    }

    [HttpPost]
    public async Task<ActionResult<TodoItem>> Create(TodoItem todoItem, CancellationToken cancellationToken)
    {
        var response = await _createTodoItemUseCase.Execute(todoItem, cancellationToken);
        return CreatedAtAction(nameof(Get), new { id = response.Id }, response);
    }
}

```

In the frameworks and drivers layer, we have the `TodoItemController` class, which acts as a web API controller responsible for handling incoming HTTP requests related to TodoItems. It depends on the `ICreateTodoItemUseCase` interface, which is implemented in the use cases layer.


## Conclusion
By following the Clean Architecture principles, we have achieved a separation of concerns and a clear modular structure. The business logic is encapsulated within the use cases and entities, independent of any specific framework or infrastructure. The interface adapters handle the communication with external dependencies such as databases, while the frameworks and drivers layer handles the web server and HTTP communication.

This architecture promotes testability, maintainability, and scalability. It allows for easy modification or replacement of individual components without affecting the entire system. Additionally, the use of interfaces and dependency injection enables loose coupling and facilitates unit testing and mocking.

In conclusion, Clean Architecture provides a solid foundation for building robust and maintainable applications by separating concerns and dependencies. By applying these principles, we have demonstrated how to structure the codebase and achieve a clean and scalable architecture.

Source code of the article: [Github source code](https://github.com/jboinembalome/IntroductionToCleanArchitecture)

*Happy coding! 🙂*