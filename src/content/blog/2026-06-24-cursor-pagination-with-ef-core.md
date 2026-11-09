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

The first paged endpoint of an API is almost always `Skip((page - 1) * size).Take(size)`. It is simple and gives page numbers for free. Then the table grows, someone scrolls a feed far down, and new rows arrive while they read. Two things go wrong: deep pages get slower, and the list shows the same row twice or skips one.


## Why OFFSET gets slow and wrong
`Skip(5000).Take(50)` becomes `ORDER BY occurred_at DESC LIMIT 50 OFFSET 5000`. The database cannot jump to row 5,001. It walks the order, reads the 5,000 rows before it and throws them away. Page 100 reads a hundred times more than page 1, even with an index.

The second problem is correctness. An offset is a position counted from the top, and the top moves. If a row is inserted at the head between page 1 and page 2, every row shifts down by one. The last row of page 1 comes back as the first row of page 2. A deletion does the opposite, and one row is never shown. On a feed or an audit log, this is the normal case.

There is a quieter issue too. If the `ORDER BY` is not unique, PostgreSQL may return tied rows in a different order on each query. Offset then repeats or skips rows even on a table that does not move.


## Continue after the last row
Keyset pagination stops counting. The client hands back the sort values of the **last row it received**, and the next page is the rows that come after it:

```sql
SELECT *
FROM audit_entries
WHERE occurred_at < @last_occurred_at
   OR (occurred_at = @last_occurred_at AND id < @last_id)
ORDER BY occurred_at DESC, id DESC
LIMIT 51;
```

With an index on `(occurred_at, id)` in the same order and directions, the database seeks straight to the position and reads 51 rows, whatever the depth. An insert at the head does not move the position, because the position is a value, not a count.

The `id` is the **tiebreaker**. `occurred_at` alone is not unique, and a strict `occurred_at < @last` would skip every row tied with the last one of the page. PostgreSQL also accepts the shorter row value form, `(occurred_at, id) < (@last_occurred_at, @last_id)`. The expanded form above works on any database and is easier to produce from LINQ.

In EF Core, a minimal version is a `Where` before the `Take`:

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

`pageSize + 1` is a cheap trick. If the extra row comes back, there is a next page, and we drop it before answering. No count query is needed to show a "load more" button.


## One helper instead of many copies
Each hand-written copy of that `Where` is a chance to get the tiebreaker or the direction wrong. [Blouppy Starter](https://starter.blouppy.com/) keeps it in one extension method, `ToCursorPageAsync`. The audit log's repository only states its order and its two keys:

```csharp
var page = await Filter(query.Filter)
    .OrderByDescending(x => x.OccurredAt)
    .ThenByDescending(x => x.Id)
    .ToCursorPageAsync(
        x => x.OccurredAt,
        x => x.Id,
        query,
        SortDirection.Desc,
        cancellationToken);
```

The matching index is `(organization_id, occurred_at DESC, id DESC)`, organization first because every query filters on it.

Inside, the helper builds the same OR expansion as an expression tree. A small `ExpressionVisitor` rebinds the tiebreaker's lambda parameter onto the key's, so both comparisons end up in one `x => ...` that EF Core can translate. For a [strongly typed id](/blog/2026-05-16-strongly-typed-ids-with-ef-core/), the helper finds the `<` operator declared on the id's base record and passes it to `Expression.LessThan`. The provider still sees a plain comparison against the column.

It returns the items with a next and a previous cursor. Going back is the part that is easy to get wrong, and the Starter's first version did. A previous cursor must read in the **reverse** order, starting from the first row of the page, then put the rows back in the list's order. Flipping the comparison but keeping the list's order returns the start of the list, not the page just before. The helper now reverses both the comparison and the order, so both directions work.


## An opaque cursor
The client should not build `(occurred_at, id)` itself. The server writes the direction, the id and the key into one string, then base64url-encodes it. Three details matter:

- **The id comes first.** Decoding splits on `:` into at most three parts, so a key that contains a colon still decodes as one value.
- **Values round-trip exactly.** A `DateTimeOffset` travels as its `UtcTicks`, under the invariant culture. A key rounded to the millisecond would name a row that does not exist.
- **A bad cursor is the client's error.** Anything that fails to decode, from the base64 to a value of the wrong type, becomes an `InvalidCursorException`, and an action filter answers it with a 400 validation problem instead of a 500.

"Opaque" means the client must not depend on the format, not that it is secret. Anyone can forge a cursor, which is fine: it is only a position, and the organization filter is applied on the server for every request.

On the Angular side, a cursor page fits a "load more" button. The audit log screen keeps the entries and the next cursor in signals, and appends each new page. When the filters change, it resets the cursor first: an old cursor with new filters would ask for "rows after this position" in a different list.


## What keyset pagination costs
There is no jumping to page 7, and no total for free: a count over a large filtered table is a scan of its own. Every sortable column needs a matching index with the tiebreaker last. And `NULL` does not compare with `<`, so a nullable sort key needs care.

So offset stays right for small, bounded tables that a person pages through with numbers. The Starter keeps it for an organization's members, with a total and page numbers. Keyset pays off when the list is long, grows at the head, or is walked by a batch job: audit logs, notifications, activity streams, exports.


## References
- [Pagination](https://learn.microsoft.com/ef/core/querying/pagination) — Microsoft Learn: offset and keyset pagination in EF Core.
- [Paging through results](https://use-the-index-luke.com/no-offset) — Markus Winand's explanation of keyset pagination.
- [Indexes and ORDER BY](https://www.postgresql.org/docs/current/indexes-ordering.html) — PostgreSQL: how a B-tree index serves an ordered query.
- [Expression trees](https://learn.microsoft.com/dotnet/csharp/advanced-topics/expression-trees/) — Microsoft Learn: building `Expression<Func<T, bool>>`.
