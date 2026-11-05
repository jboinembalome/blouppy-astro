---
templateKey: 'blog-post'
title: 'Signed outgoing webhooks in ASP.NET Core'
date: 2026-09-19T09:00:00.000Z
author: Jimmy Boinembalome
authorimage: /img/jimmy.jpg
category: C#
categorycolor: bg-purple-100 text-purple-800
featuredpost: true
featuredimage: /img/signed-outgoing-webhooks-in-aspnet-core.jpg
description: >-
  Learn how to send signed outgoing webhooks from ASP.NET Core: a stable envelope, an HMAC signature a subscriber can verify, durable retries, delivery history and redelivery.
tags:
  - Development
  - C#
  - ASP.NET Core
  - Webhooks
  - Security
  - EF Core
---

Sooner or later, a customer asks for webhooks: "when a workspace is created, call my provisioning script". It looks like one `HttpClient.PostAsync` in an event handler. It is not: the subscriber must be able to prove the request came from us, a deploy in the middle must not lose the delivery, a failing endpoint must be retried for hours, and somebody must be able to see what was sent and send it again.

In this article, we will walk through the whole feature as it exists in the code base this comes from: the envelope, the signature and its verification, the secret, the delivery pipeline, retries, history, test deliveries and retention.


## The envelope
Every body has the same shape, and only `data` varies by event. Here is `WebhookEventEnvelope`, in `Blouppy.Webhooks.Models/Events/`:

```csharp
public sealed record WebhookEventEnvelope
{
    public required string Event { get; init; }

    // Repeats the X-Blouppy-Delivery header inside the signed body: headers are not signed.
    public required string Delivery { get; init; }

    public required int OrganizationId { get; init; }

    public required DateTimeOffset OccurredAt { get; init; }

    public required object Data { get; init; }
}
```

- `Event` is the **wire name**, such as `workspace.created`. It is spelled out in a `switch` (`WebhookEventTypeExtensions.ToWireName()`) rather than derived from the enum member's name, because renaming a C# member must never change a public contract.
- `Delivery` is the delivery id. It is also sent as a header, but the copy that counts is this one: the signature covers the body, not the headers, so this is the id a subscriber should deduplicate on.
- `Data` holds **identifiers only**: for `workspace.created`, a `WebhookEventData.Workspace(int Id, string ActorId)`.

The invitation event once carried the invitee's e-mail; it no longer does, and it never carries the invitation token, a bearer credential. A subscriber reads the details from the API with its own credentials, which also stops a webhook from handing out data its owner could not otherwise read. 👍

The envelope is serialized with options that live next to it, not with the MVC ones:

```csharp
// Fixed here rather than taken from the MVC options: the body is signed, so its format must not drift.
internal static class WebhookPayloadSerialization
{
    public static readonly JsonSerializerOptions Options = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
        WriteIndented = false
    };
}
```

If someone changes the API's JSON settings next year, our controllers should follow. The webhook bodies must not: subscribers have parsers, and the bytes are what gets signed. Here is what a subscriber receives:

```json
{
  "event": "workspace.created",
  "delivery": "9f2c41e07b8d4a5e9c3f16d284b70a5c",
  "organizationId": 1,
  "occurredAt": "2026-09-20T20:44:28.740Z",
  "data": {
    "id": 12,
    "actorId": "u1"
  }
}
```


## Signing the request
Five headers go with each request, all constants in `WebhookRules` (the one class that holds every number and name the feature agrees on): `X-Blouppy-Signature`, `X-Blouppy-Timestamp`, `X-Blouppy-Event`, `X-Blouppy-Delivery` and `X-Blouppy-Webhook-Id`. The signature is an HMAC-SHA256 over the timestamp **and** the body. Here is `WebhookSignature`, in `Blouppy.Infrastructure.Webhooks`:

```csharp
// The timestamp is signed with the body so a captured delivery cannot be replayed with a fresh timestamp.
internal static class WebhookSignature
{
    private const string Prefix = "sha256=";

    public static string Compute(string secret, string timestamp, string payload)
    {
        var key = Encoding.UTF8.GetBytes(secret);
        var message = Encoding.UTF8.GetBytes($"{timestamp}.{payload}");

        return Prefix + Convert.ToHexStringLower(HMACSHA256.HashData(key, message));
    }
}
```

- The key is the secret string as the administrator sees it, taken as UTF-8.
- The signed message is `{unix seconds}.{raw body}`. Signing only the body would let an attacker replay a captured request with a fresh timestamp header.

`HttpWebhookSender` builds the request. Custom headers (an API key the subscriber's gateway expects, say) are added first, and ours win any collision:

```csharp
var timestamp = DateTimeOffsetProvider.UtcNow.ToUnixTimeSeconds()
    .ToString(CultureInfo.InvariantCulture);

// Subscriber headers go on first so ours win any collision.
foreach ((string name, string value) in request.Headers)
{
    httpRequest.Headers.TryAddWithoutValidation(name, value);
}

httpRequest.Headers.Remove(WebhookRules.SignatureHeaderName);
// ... the four other reserved headers

httpRequest.Headers.TryAddWithoutValidation(
    WebhookRules.SignatureHeaderName,
    WebhookSignature.Compute(request.Secret, timestamp, request.Payload));
httpRequest.Headers.TryAddWithoutValidation(WebhookRules.TimestampHeaderName, timestamp);
```

The domain already refuses a custom header named like one of ours (`WebhookRules.ReservedHeaderNames`), so the `Remove` calls are a second belt: a subscription must never be able to rewrite its own signature or event name.

> **_Note:_**  The timestamp is taken at the moment of **each attempt**, not when the event happened. A retry six hours later carries a fresh timestamp and a fresh signature, so a subscriber rejecting old timestamps does not reject our retries.


## Verifying it on the subscriber's side
The subscriber does the same computation over the **raw bytes** it received, before any JSON parsing: re-serializing the body changes it, and the signature with it. Here is a minimal ASP.NET Core receiver, a C# port of the Node.js and Python samples in the public guide:

```csharp
app.MapPost("/hooks/blouppy", async (HttpRequest request, IConfiguration configuration) =>
{
    using var reader = new StreamReader(request.Body, Encoding.UTF8);
    var rawBody = await reader.ReadToEndAsync();

    var timestamp = request.Headers["X-Blouppy-Timestamp"].ToString();
    var signature = request.Headers["X-Blouppy-Signature"].ToString();

    // Reject anything older than five minutes: the timestamp is inside the signed string.
    if (!long.TryParse(timestamp, out var seconds)
        || Math.Abs(DateTimeOffset.UtcNow.ToUnixTimeSeconds() - seconds) > 300)
    {
        return Results.Unauthorized();
    }

    var key = Encoding.UTF8.GetBytes(configuration["Webhooks:SigningSecret"]!);
    var expected = "sha256=" + Convert.ToHexStringLower(
        HMACSHA256.HashData(key, Encoding.UTF8.GetBytes($"{timestamp}.{rawBody}")));

    // Constant time: a plain == leaks how much of the signature was right.
    if (!CryptographicOperations.FixedTimeEquals(
            Encoding.UTF8.GetBytes(expected),
            Encoding.UTF8.GetBytes(signature)))
    {
        return Results.Unauthorized();
    }

    // Deduplicate on the "delivery" of the body, queue the work, answer fast.
    return Results.Ok();
});
```

- `CryptographicOperations.FixedTimeEquals` returns `false` for spans of different lengths, so a truncated or missing signature fails safely.
- The receiver answers quickly and does its work afterwards: the sender gives each attempt `WebhookRules.SendTimeout`, ten seconds, and anything slower counts as a failure.


## The secret: shown once, rotatable
A webhook's secret is 32 random bytes, Base64-encoded, generated by the entity itself:

```csharp
private static string GenerateSecret()
    => Convert.ToBase64String(RandomNumberGenerator.GetBytes(WebhookRules.SecretLengthInBytes));
```

Unlike a password, it cannot be hashed: the server needs it in clear to compute every signature. So it is encrypted **at rest** instead, with ASP.NET Core Data Protection behind an `ISecretProtector` port, applied by an EF Core value converter so the model never sees ciphertext.

The API returns it in exactly two places, creation and rotation, both through a dedicated `WebhookSecretDto`:

```csharp
/// <summary>
/// Returned by creation and rotation only: no read returns the secret, so a lost one is rotated.
/// </summary>
public sealed record WebhookSecretDto
{
    public required WebhookDto Webhook { get; init; }

    public required string Secret { get; init; }
}
```

Rotation is `Webhook.RotateSecret()`, which raises `WebhookSecretRotatedDomainEvent` (the fact, never the secret) for the audit log. Because the sender reads the secret from the webhook row at send time, a rotation applies to the very next attempt, retries of deliveries queued before it included.


## The delivery, in three hops
Here is the path from a change in the application to the subscriber's endpoint:

```text:clipboard=false
1. a domain commits its change + an integration event      (bus outbox, one transaction)
2. WebhookEventDispatcher writes one WebhookDelivery row per subscribed webhook,
   commits, then publishes WebhookDeliveryRequested(deliveryId, claimId) per row
3. WebhookDeliveryRequestedConsumer → IWebhookDeliveryService.SendAsync
   makes exactly one HTTP request, records the attempt, commits
```

The rule that makes it hold together: **the row is the source of truth; the message is only a nudge.** The dispatcher writes the exact serialized envelope into the row, and the message carries two ids and nothing else. At send time, the URL, the secret and the custom headers are read from the webhook, so nothing sensitive ever sits in a queue. A few things protect this path, and each has its own article:
- The delivery id is derived from the bus message id and the webhook id, so a retried event finds its rows instead of writing new ones ([idempotent message handlers](https://www.blouppy.com/blog/2026-08-20-idempotent-message-handlers-with-deterministic-ids/)).
- Each row is claimed with a token and a lease, and `xmin` makes two concurrent claims impossible to commit ([optimistic concurrency with xmin](https://www.blouppy.com/blog/2026-08-02-optimistic-concurrency-with-postgresql-xmin-in-ef-core/)).
- The `webhooks` client resolves and checks every address itself before connecting ([SSRF-proof outgoing HTTP calls](https://www.blouppy.com/blog/2026-07-09-ssrf-proof-outgoing-http-calls-in-dotnet/)).
- That client clears Aspire's default resilience handler, so one attempt is exactly one request ([the AddStandardResilienceHandler trap](https://www.blouppy.com/blog/2026-06-15-the-addstandardresiliencehandler-trap/)).

Hop 3 has its own queue, capped at 16 concurrent attempts per replica (`WebhookDeliveryRequestedConsumer.MaxConcurrentAttempts`).


## Retries: the schedule lives in the row
`SendAsync` never throws because a subscriber said no. It records the outcome:

```csharp
if (result.Succeeded)
{
    delivery.MarkAsSucceeded(result.StatusCode!.Value, result.ResponseBody);
}
else
{
    delivery.MarkAsFailed(result.StatusCode, result.ResponseBody, result.Error);
}

await unitOfWork.CommitAsync(cancellationToken);
```

A `2xx` is a success; anything else, a timeout or a refused connection is a failed attempt. `MarkAsFailed` then writes the next due time from `WebhookRules.RetryBackoff`:

```csharp
public static readonly IReadOnlyList<TimeSpan> RetryBackoff =
[
    TimeSpan.FromMinutes(1),
    TimeSpan.FromMinutes(5),
    TimeSpan.FromMinutes(30),
    TimeSpan.FromHours(2),
    TimeSpan.FromHours(6)
];

public static int MaxAttempts => RetryBackoff.Count + 1;
```

Six attempts in all, spread over almost nine hours. No timer survives that long, and none is needed: a Quartz.NET job, `WebhookDeliverySweepJob`, asks every 30 seconds which rows are due and queues them through the outbox. A deploy in the middle costs a delay, never the delivery.

Why not let the bus retry? A message retry is measured in seconds and dies with the process; the row's budget is measured in hours and survives a restart.


## Delivery history and redelivery
Since every attempt is written into its row, the history is just a read. `IWebhooksApiQueryService` exposes `GetDeliveriesAsync` (an `OffsetPage<WebhookDelivery>`, newest first) and `TryGetDeliveryAsync`, and a delivery shows the exact signed payload, the status, the attempt count, the response code, the first 64 KiB of the response body (`WebhookRules.MaxStoredResponseLength`) and, while it is pending, when the next attempt is due.

A settled delivery can be sent again with `POST .../webhooks/{id}/deliveries/{deliveryId}/redeliver`. Here is the domain side:

```csharp
public void Redeliver()
{
    Status = WebhookDeliveryStatus.Pending;
    CompletedAt = null;
    RetriedFrom = AttemptCount;
    Claim();
}
```

- `TryRedeliverAsync` refuses a delivery that is still `Pending`: it is already being attempted.
- `RetriedFrom` remembers where this round started, so `MarkAsFailed` gives the redelivery a **full budget** without resetting `AttemptCount`. The history stays true: an attempt that happened is never rewritten.


## Test deliveries
`IWebhooksService.TryTestAsync` builds a delivery like any other, with its own random id and a body that says what it is:

```csharp
var payload = JsonSerializer.Serialize(
    new WebhookEventEnvelope
    {
        Event = eventType.ToWireName(),
        Delivery = deliveryId.Value,
        OrganizationId = organizationId.Value,
        OccurredAt = DateTimeOffsetProvider.UtcNow,
        Data = new WebhookEventData.Test(
            IsTest: true,
            Message: "This is a test delivery from Blouppy. No event occurred.")
    },
    WebhookPayloadSerialization.Options);
```

It uses the webhook's first event name, the same options, signature and history. A test that took a different path would prove nothing about the real one. 😉


## Retention
The history cannot grow forever. A settled delivery (succeeded, or failed with its budget spent) is deleted 30 days after it completed (`WebhookRules.DeliveryRetention`), by `WebhookDeliveryPurgeJob`. It runs hourly rather than on every sweep: it is a bulk delete across every organization, and nothing about it is urgent.

A pending row is never purged, whatever its age. Deleting a webhook takes its deliveries with it (`ON DELETE CASCADE`), and deleting an organization takes its webhooks.

> **_Note:_**  Tell subscribers that events are **not ordered** (read the current state from the API) and that a paused webhook **drops** events rather than buffering them.


## Conclusion
A signed webhook is a small contract with large consequences: an envelope whose serialization is frozen because its bytes are signed, an HMAC over the timestamp and the body that any subscriber can check in a dozen lines, and a secret that is shown once, encrypted at rest and rotated rather than recovered.

Behind it, the delivery is a row, not a message: the dispatcher writes it, a nudge on the bus makes one attempt, and the row carries its own retry schedule (1 min, 5 min, 30 min, 2 h, 6 h), its history, its redelivery and its 30-day retention. Test deliveries take the exact same path, so they prove something.

This is how outgoing webhooks are built in [Blouppy Starter](https://starter.blouppy.com/); the [webhooks module's documentation](https://docs.starter.blouppy.com/modules/webhooks/) covers the configuration and how to offer a new event.

*Thanks for reading! 🙂*
