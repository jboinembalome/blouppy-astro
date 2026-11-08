---
templateKey: 'blog-post'
title: 'Cursor pagination with EF Core: why OFFSET gets slow and wrong'
date: 2026-06-24T09:00:00.000Z
author: Jimmy Boinembalome
authorimage: /img/jimmy.jpg
category: C#
topic: 'Data'
illustration: 3
categorycolor: bg-purple-100 text-purple-800
featuredpost: true
description: >-
  Learn why Skip/Take pagination slows down and repeats rows on a moving list, and how to build keyset pagination in EF Core with a tiebreaker, a matching index and an opaque cursor.
tags:
  - Development
  - C#
  - EF Core
  - PostgreSQL
---

The first paged endpoint of an API is almost always `Skip((page - 1) * size).Take(size)`. It is simple and gives page numbers for free. Then the table grows, someone scrolls a feed far down, new rows arrive while they read, and two things go wrong: the deep pages get slower, and the list shows the same row twice or skips one.

In this article, we will see why **OFFSET** pagination has these two problems, build **keyset (cursor) pagination** in EF Core with a stable tiebreaker, an index that matches the order and an opaque cursor, and consume it from Angular with a "load more" button. We will finish with what keyset pagination costs and when offset stays the right choice.


## The two problems of OFFSET
Here is the usual offset query:

```csharp
var page = await dbContext.AuditEntries
    .OrderByDescending(x => x.OccurredAt)
    .Skip((pageNumber - 1) * pageSize)
    .Take(pageSize)
    .ToListAsync(cancellationToken);
```

PostgreSQL turns it into `ORDER BY occurred_at DESC LIMIT 50 OFFSET 5000`. The first problem is **cost**. The database has no way to jump to row 5,001: it walks the order, reads the 5,000 rows before it and throws them away. Even with an index on `occurred_at`, page 100 reads a hundred times more than page 1. The cost grows with the depth of the page, not with its size.

The second problem is **correctness**. An offset is a position counted from the top, and the top moves. If a row is inserted at the head of the list between the reads of page 1 and page 2, every row shifts down by one: the last row of page 1 becomes the first row of page 2, and the reader sees it twice. If a row is deleted, every row shifts up, and one row is never shown at all. On a feed, an audit log or a notification list, rows arrive all the time, so this is the normal case.

There is a third, quieter issue: if the `ORDER BY` is not unique, PostgreSQL is free to return rows that share a sort value in any order, and that order can differ between two queries. Offset pagination then repeats or skips rows even on a table that does not move.


## Keyset pagination: continue after the last row
Keyset pagination stops counting rows. The client hands back the sort values of the **last row it received**, and the next page is "the rows that come after it":

```sql
SELECT *
FROM audit_entries
WHERE (occurred_at, id) < (@last_occurred_at, @last_id)
ORDER BY occurred_at DESC, id DESC
LIMIT 50;
```

With an index on `(occurred_at, id)`, the database seeks straight to the position and reads 50 rows, whatever the depth. Inserts at the head do not move the position, because the position is a value, not a count: the next page starts exactly after the last row seen.

Three ingredients make it work:

- **A stable tiebreaker.** `occurred_at` alone is not unique: two entries written in the same microsecond share it. A strict `occurred_at < @last` would skip every row tied with the last row of the page. Adding the primary key as the last term of the order makes every position unique.
- **An index that matches the order.** Same columns, same order, same directions. Otherwise the database sorts the whole filtered set for every page and the gain is gone.
- **An opaque cursor.** The client should not build `(occurred_at, id)` itself. The server encodes the values into a string, the client stores it and sends it back unchanged.

The `(a, b) < (x, y)` syntax is a PostgreSQL **row value comparison**. Not every database supports it, so the portable form expands it:

```sql
WHERE occurred_at < @last_occurred_at
   OR (occurred_at = @last_occurred_at AND id < @last_id)
```

Both forms return the same rows. PostgreSQL can use the row value form directly as one range condition on a B-tree index over `(occurred_at, id)`; the expanded form is easier to produce from LINQ and works on any provider. The [EF Core documentation on pagination](https://learn.microsoft.com/ef/core/querying/pagination#keyset-pagination) shows the expanded form.

In plain EF Core, a minimal version is a `Where` before the `Take`:

```csharp
var query = dbContext.AuditEntries
    .Where(x => x.OrganizationId == organizationId);

if (cursor is { } last)
{
    query = query.Where(x => x.OccurredAt < last.OccurredAt
        || (x.OccurredAt == last.OccurredAt && x.Id < last.Id));
}

var items = await query
    .OrderByDescending(x => x.OccurredAt)
    .ThenByDescending(x => x.Id)
    .Take(pageSize + 1)
    .ToListAsync(cancellationToken);
```

`pageSize + 1` is a cheap trick: if the extra row comes back, there is a next page, and we drop it before answering. No count query is needed to know whether to show "load more".


## A generic helper in Blouppy Starter
Each hand-written copy of that `Where` is a chance to get the tiebreaker or the direction wrong. [Blouppy Starter](https://starter.blouppy.com/) keeps it in one place, `PaginationExtensions` in `Blouppy.Infrastructure.Database/Paging`. As described in [Separating reads and writes in ASP.NET Core without MediatR](/blog/2026-06-21-separating-reads-and-writes-without-mediatr/), the read side has two page shapes in `Blouppy.ApiQuery.Models/Paging`:

```csharp
public class CursorPage<T>
    where T : class
{
    public IEnumerable<T> Items { get; set; } = [];
    public string? NextCursor { get; set; }
    public string? PreviousCursor { get; set; }
}

public interface ICursorQuery
{
    string? Cursor { get; init; }
    int Limit { get; init; }
}
```

`OffsetPage<T>` and `IOffsetQuery` are the offset twins, with `Page`, `PageSize`, `NextPage`, `PreviousPage` and `TotalCount`.

The audit log is the clearest caller. The repository orders newest first, with the id settling entries of the same instant, and passes both selectors to the helper:

```csharp
internal sealed class AuditLogApiQueryRepository(
    BlouppyDbContext dbContext) : IAuditLogApiQueryRepository
{
    public async Task<CursorPage<AuditLogEntry>> GetAsync(
        AuditLogQuery query,
        CancellationToken cancellationToken = default)
    {
        var page = await Filter(query.Filter)
            .OrderByDescending(x => x.OccurredAt)
            .ThenByDescending(x => x.Id)
            .ToCursorPageAsync(
                x => x.OccurredAt,
                x => x.Id,
                query,
                SortDirection.Desc,
                cancellationToken);

        // Maps the entries and resolves the people they name.
    }
}
```

The entity configuration declares the index that matches this order, organization first because every query filters on it:

```csharp
builder.HasIndex(x => new { x.OrganizationId, x.OccurredAt, x.Id })
    .IsDescending(false, true, true);
```

Inside the helper, the condition is an expression tree built from the two selectors. It uses the **OR expansion**, not a row value comparison:

```csharp
var keyComparison = BuildComparison(cursorSelector.Body, decodedCursor, sortDirection);

// The tiebreaker selector has its own parameter; rebinding it onto the
// cursor's keeps both comparisons in one lambda.
var tiebreakerAccess = new ParameterRebinder(tiebreakerSelector.Parameters[0], parameter)
    .Visit(tiebreakerSelector.Body);

var keyIsEqual = Expression.Equal(
    cursorSelector.Body,
    Expression.Constant(decodedCursor, cursorSelector.Body.Type));

var tiebreakerComparison = BuildComparison(tiebreakerAccess, decodedTiebreaker, sortDirection);

return Expression.Lambda<Func<T, bool>>(
    Expression.OrElse(
        keyComparison,
        Expression.AndAlso(keyIsEqual, tiebreakerComparison)),
    parameter);
```

`ParameterRebinder` is a small `ExpressionVisitor` that swaps one lambda parameter for another, so `x => x.OccurredAt` and `x => x.Id` end up in a single `x => ...` that EF Core can translate. `BuildComparison` emits `GreaterThan` or `LessThan` depending on the direction. For a strongly typed id such as `AuditEntryId`, the ordering operators are declared on a shared base record, so the helper finds `op_LessThan` by reflection and passes it to `Expression.LessThan`; the provider then sees a plain comparison against the column, as explained in [Strongly typed IDs in C# with EF Core and PostgreSQL](/blog/2026-05-16-strongly-typed-ids-with-ef-core/).

The rest of the helper is the `Limit + 1` trick, then two cursors built from the first and last items of the page.


## An opaque cursor
`CursorEncoder` writes the direction, the tiebreaker and the key into one string, then base64url-encodes it:

```csharp
public static string EncodeCursor<TKey, TId>(CursorDirection cursorDirection, TKey key, TId id)
    where TKey : notnull
    where TId : notnull
    => Envelope($"{cursorDirection}:{Format(id)}:{Format(key)}");

private static string Envelope(string payload)
    => Convert.ToBase64String(Encoding.UTF8.GetBytes(payload))
        .TrimEnd('=')
        .Replace('+', '-')
        .Replace('/', '_');
```

A few details in it matter more than they look:

- **The id comes first.** Decoding splits on `:` into at most three parts, so a key that itself contains a colon still decodes as one value.
- **Values round-trip exactly.** A `DateTimeOffset` travels as its `UtcTicks`, a `double` with the `"R"` format, everything under the invariant culture. A key rounded to the millisecond would name a row that does not exist, and the comparison would skip or repeat its neighbours.
- **Old cursors still work.** A cursor issued before the tiebreaker existed has no id. It decodes with a null one, and the helper falls back to the strict comparison it was issued under, so a client holding such a cursor gets an answer rather than an error.

"Opaque" means the client must not depend on the format, not that the content is secret. Base64 is not encryption: anyone can decode and forge a cursor. That is acceptable here because a cursor is only a position. The organization filter is applied on the server for every request, so a forged cursor can only move inside rows the caller may already read. If a cursor ever carried something the client must not change, it would need a signature.

The page size is bounded before the controller runs. `CursorQueryValidationFilter` is a global action filter that answers 400 when `Limit` is below 1 or above 1,000, and the audit log's DTO narrows that further to 100 with a `[Range]` attribute.


## Consuming it from Angular
A cursor page fits an infinite list or a "load more" button, not a pager. The audit log screen keeps the entries and the next cursor in signals, replaces the list on the first page and appends on the next ones:

```ts
public readonly entries = signal<AuditLogEntry[]>([]);
public readonly nextCursor = signal<string | null>(null);

this._nextPages
  .pipe(
    switchMap(request => {
      this.isLoadingMore.set(true);
      return this.read(request);
    }),
    takeUntilDestroyed(this._destroyRef)
  )
  .subscribe(page => {
    this.isLoadingMore.set(false);

    if (page) {
      this.entries.update(entries => [...entries, ...page.items]);
      this.nextCursor.set(page.nextCursor ?? null);
    }
  });

public loadMore(): void {
  const organizationId = this.organizationId();
  const cursor = this.nextCursor();
  if (organizationId === null || !cursor) return;

  this._nextPages.next({ organizationId, filter: this.filter(), cursor });
}
```

The template shows the button only while `nextCursor()` is set. When the filters change, the first-page stream resets `nextCursor` to `null` before it reads, and `switchMap` cancels a read the new filters made stale. That reset matters: the cursor knows nothing about the filters, so sending an old cursor with new filters would ask for "rows after this position" in a different list.

The same cursor serves the server too. The CSV export of the audit log walks the index a thousand rows at a time by calling `GetAsync` in a loop until `NextCursor` is null, so it never holds the whole log in memory and is never slowed down by deep offsets.


## What we lose
Keyset pagination is not free:

- **No jumping to page 7.** A position is reached by walking from the start. A UI that needs page numbers cannot have them.
- **No total for free.** `ToOffsetPageAsync` runs a `CountAsync` on every request to fill `TotalCount`; `CursorPage<T>` has no count at all. A count over a large filtered table is itself a full scan of the matching rows, so if a screen needs "1,284 entries", it pays for it separately.
- **The sort is constrained.** Every sortable column needs a matching index with the tiebreaker as its last term, and the cursor's key has to be the sorted column. A table with ten sortable columns means ten indexes or slow pages.
- **Going backwards is harder.** Reading the previous page means reversing the comparison and the order, then reversing the result. The audit log screen only moves forward and never uses `PreviousCursor`.
- **Nullable keys need care.** `NULL` does not compare with `<` or `>`, so rows with a null sort key fall out of the `WHERE`. Sort on a non-null column, or coalesce it.


## When OFFSET stays right
Blouppy Starter keeps it for the organization's members, a table that an administrator pages through with numbers and a total. Keep offset when:

- the table is small and bounded, such as members, plans or settings, where page 20 is never more than a few hundred rows deep;
- the screen needs page numbers or "page 3 of 12";
- the data barely moves while someone reads it, as in an admin table;
- the user sorts on many arbitrary columns and indexing each one is not worth it.

Use keyset pagination when the list is long, grows at the head, is read as a feed, or is walked by a batch job: audit logs, notifications, activity streams, exports.


## Conclusion
OFFSET counts rows from a top that moves, so it reads more for every page and repeats or skips rows when the data changes. Keyset pagination continues from the last row seen: a `WHERE` on the sort key with a unique tiebreaker, an index in the same order, and a cursor the client hands back unchanged. In EF Core, a small helper with an expression tree keeps that `WHERE` correct in one place, and on the Angular side the cursor becomes a "load more" button. The price is page numbers and totals, which is why offset stays the better choice for small admin tables.


## References
- [Pagination (Microsoft Learn)](https://learn.microsoft.com/ef/core/querying/pagination) — EF Core documentation on offset and keyset pagination.
- [Expression trees (Microsoft Learn)](https://learn.microsoft.com/dotnet/csharp/advanced-topics/expression-trees/) — building and visiting `Expression<Func<T, bool>>`.
- [ExpressionVisitor class (Microsoft Learn)](https://learn.microsoft.com/dotnet/api/system.linq.expressions.expressionvisitor) — the base class behind `ParameterRebinder`.
- [LIMIT and OFFSET (PostgreSQL)](https://www.postgresql.org/docs/current/queries-limit.html) — why the rows skipped by `OFFSET` are still computed.
- [Row constructor comparison (PostgreSQL)](https://www.postgresql.org/docs/current/functions-comparisons.html#ROW-WISE-COMPARISON) — the `(a, b) < (x, y)` syntax.
- [Indexes and ORDER BY (PostgreSQL)](https://www.postgresql.org/docs/current/indexes-ordering.html) — how a B-tree index serves an ordered query.
- [Paging through results (Use The Index, Luke)](https://use-the-index-luke.com/no-offset) — Markus Winand's explanation of keyset pagination.
- [Blouppy Starter](https://starter.blouppy.com/) — the starter kit the examples come from.
