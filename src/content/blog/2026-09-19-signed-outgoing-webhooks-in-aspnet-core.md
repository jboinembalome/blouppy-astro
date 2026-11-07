---
templateKey: 'blog-post'
title: 'Signed outgoing webhooks in ASP.NET Core'
date: 2026-09-19T09:00:00.000Z
updated: 2026-11-07T09:00:00.000Z
author: Jimmy Boinembalome
authorimage: /img/jimmy.jpg
category: C#
topic: 'Messaging'
illustration: 2
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

A customer asks: "when a workspace is created, call my provisioning script". It looks like one `HttpClient.PostAsync` in an event handler. It is not: the subscriber must be able to prove the request came from us, a deploy must not lose the delivery, a failing endpoint must be retried for hours, and someone must be able to see what was sent and send it again. In this article, we will walk through the whole feature, from the envelope to retention.


## The envelope
Every body has the same shape; only `data` varies by event. Here is `WebhookEventEnvelope`, in `Blouppy.Webhooks.Models/Events/`:

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

- `Event` is the **wire name**, such as `workspace.created`, spelled out in a `switch` (`ToWireName()`) so that renaming an enum member never changes a public contract.
- `Delivery` is also sent as a header, but only the body is signed, so this is the id to deduplicate on.
- `Data` holds **identifiers only**, such as `WebhookEventData.Workspace(int Id, string ActorId)`: never an e-mail or a token. A subscriber reads the details from the API with its own credentials.

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

If the API's JSON settings change, the controllers should follow; the webhook bodies must not, because subscribers have parsers and the bytes are what gets signed:

```json
{"event":"workspace.created","delivery":"9f2c41e07b8d4a5e9c3f16d284b70a5c","organizationId":1,"occurredAt":"2026-09-20T20:44:28.740Z","data":{"id":12,"actorId":"u1"}}
```


## Signing the request
Five headers go with each request, all constants in `WebhookRules`: `X-Blouppy-Signature`, `X-Blouppy-Timestamp`, `X-Blouppy-Event`, `X-Blouppy-Delivery` and `X-Blouppy-Webhook-Id`. The signature is an [HMAC-SHA256](https://learn.microsoft.com/dotnet/api/system.security.cryptography.hmacsha256) over the timestamp **and** the body:

```csharp
// The timestamp is signed with the body so a captured delivery cannot be replayed with a fresh timestamp.
internal static class WebhookSignature
{
    private const string Prefix = "sha256=";

    public static string Compute(string secret, string timestamp, string payload)
    {
        ArgumentNullException.ThrowIfNull(secret);
        ArgumentNullException.ThrowIfNull(timestamp);
        ArgumentNullException.ThrowIfNull(payload);

        var key = Encoding.UTF8.GetBytes(secret);
        var message = Encoding.UTF8.GetBytes($"{timestamp}.{payload}");

        return Prefix + Convert.ToHexStringLower(HMACSHA256.HashData(key, message));
    }
}
```

The key is the secret string in UTF-8, and the signed message is `{unix seconds}.{raw body}`, the scheme [Stripe](https://docs.stripe.com/webhooks) uses; the [Standard Webhooks](https://www.standardwebhooks.com/) specification also signs the message id, which the envelope's signed `delivery` covers here.

`HttpWebhookSender` builds the request. Custom headers (an API key the subscriber's gateway expects, say) go on first, and ours win any collision:

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

The domain already refuses a custom header named like one of ours (`WebhookRules.ReservedHeaderNames`); the `Remove` calls are a second safeguard.

> **_Note:_**  The timestamp is taken at **each attempt**, not when the event happened. A retry six hours later carries a fresh timestamp and signature, so a subscriber that rejects old timestamps still accepts our retries.


## Verifying it on the subscriber's side
The subscriber repeats the computation over the **raw body**, before any JSON parsing: re-serializing changes the bytes. Here is a minimal ASP.NET Core receiver, a C# port of the Node.js and Python samples in the public guide:

```csharp
app.MapPost("/hooks/blouppy", async (HttpRequest request, IConfiguration configuration, CancellationToken cancellationToken) =>
{
    using var reader = new StreamReader(request.Body, Encoding.UTF8);
    var rawBody = await reader.ReadToEndAsync(cancellationToken);

    var timestamp = request.Headers["X-Blouppy-Timestamp"].ToString();
    var signature = request.Headers["X-Blouppy-Signature"].ToString();

    // Reject anything older than five minutes: the timestamp is inside the signed string.
    if (!long.TryParse(timestamp, out var seconds)
        || Math.Abs(DateTimeOffset.UtcNow.ToUnixTimeSeconds() - seconds) > 300)
    {
        return Results.Unauthorized();
    }

    var secret = configuration["Webhooks:SigningSecret"]
        ?? throw new InvalidOperationException("Webhooks:SigningSecret is not configured.");

    var expected = "sha256=" + Convert.ToHexStringLower(
        HMACSHA256.HashData(Encoding.UTF8.GetBytes(secret), Encoding.UTF8.GetBytes($"{timestamp}.{rawBody}")));

    // Constant time: a plain == leaks how much of the signature was right.
    if (!CryptographicOperations.FixedTimeEquals(
            Encoding.UTF8.GetBytes(expected),
            Encoding.UTF8.GetBytes(signature)))
    {
        return Results.Unauthorized();
    }

    // Deduplicate on the body's "delivery", queue the work, answer fast.
    return Results.Ok();
});
```

- [`CryptographicOperations.FixedTimeEquals`](https://learn.microsoft.com/dotnet/api/system.security.cryptography.cryptographicoperations.fixedtimeequals) returns `false` for spans of different lengths, so a truncated or missing signature fails safely.
- The receiver must answer within `WebhookRules.SendTimeout`, ten seconds, so it queues the work and answers first.

Tested with a body signed by `openssl dgst -sha256 -hmac`, it answers 200 to the right signature and 401 to a wrong one.


## The secret: shown once, rotatable
A webhook's secret is 32 random bytes, Base64-encoded, generated by the entity:

```csharp
private static string GenerateSecret()
    => Convert.ToBase64String(RandomNumberGenerator.GetBytes(WebhookRules.SecretLengthInBytes));
```

Unlike a password, it cannot be hashed: the server needs it in clear to sign. So it is encrypted **at rest** with [ASP.NET Core Data Protection](https://learn.microsoft.com/aspnet/core/security/data-protection/introduction), behind an `ISecretProtector` port applied by an EF Core value converter.

Only creation and rotation return it, through a dedicated `WebhookSecretDto`; a lost secret is rotated. `Webhook.RotateSecret()` raises `WebhookSecretRotatedDomainEvent` (the fact, never the secret) for the audit log. The sender reads the secret at send time, so a rotation applies to the next attempt, retries included.


## The delivery, in three hops
Here is the path from a change in the application to the subscriber's endpoint:

```text:clipboard=false
1. a domain commits its change + an integration event      (bus outbox, one transaction)
2. WebhookEventDispatcher writes one WebhookDelivery row per subscribed webhook,
   commits, then publishes WebhookDeliveryRequested(deliveryId, claimId) per row
3. WebhookDeliveryRequestedConsumer → IWebhookDeliveryService.SendAsync
   makes exactly one HTTP request, records the attempt, commits
```

**The row is the source of truth; the message is only a nudge** carrying two ids. The URL, the secret and the headers are read at send time, so nothing sensitive sits in a queue. Hop 3 has its own queue, capped at 16 concurrent attempts per replica. Four safeguards have their own articles:
- The delivery id is derived from the bus message id and the webhook id, so a retried event finds its rows ([idempotent message handlers](https://www.blouppy.com/blog/2026-08-20-idempotent-message-handlers-with-deterministic-ids/)).
- Each row is claimed with a token and a lease, guarded by `xmin` ([optimistic concurrency with xmin](https://www.blouppy.com/blog/2026-08-02-optimistic-concurrency-with-postgresql-xmin-in-ef-core/)).
- The HTTP client checks every address before connecting ([SSRF-proof outgoing HTTP calls](https://www.blouppy.com/blog/2026-07-09-ssrf-proof-outgoing-http-calls-in-dotnet/)).
- It has no resilience handler, so one attempt is one request ([the AddStandardResilienceHandler trap](https://www.blouppy.com/blog/2026-06-15-the-addstandardresiliencehandler-trap/)).


## Retries: the schedule lives in the row
`SendAsync` never throws because a subscriber said no. A `2xx` is a success; anything else, a timeout or a refused connection is recorded by `delivery.MarkAsFailed(...)`, which computes the next due time from `WebhookRules.RetryBackoff`:

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

Six attempts over almost nine hours. No timer is needed: a [Quartz.NET](https://www.quartz-scheduler.net/documentation/) job, `WebhookDeliverySweepJob`, queues the due rows every 30 seconds through the outbox, so a deploy costs a delay, never a delivery. A bus retry would not do: it lasts seconds and dies with the process.


## Delivery history and redelivery
Every attempt is written into its row, so the history is a read (`IWebhooksApiQueryService.GetDeliveriesAsync`, newest first). A delivery shows the signed payload, the status, the attempt count, the response code, the first 64 KiB of the response body and, while pending, the next due time.

A settled delivery can be sent again with `POST .../webhooks/{id}/deliveries/{deliveryId}/redeliver`:

```csharp
public void Redeliver()
{
    Status = WebhookDeliveryStatus.Pending;
    CompletedAt = null;
    RetriedFrom = AttemptCount;
    Claim();
}
```

`TryRedeliverAsync` refuses a delivery that is still `Pending`. `RetriedFrom` records where this round started, so the redelivery gets a **full budget** without resetting `AttemptCount`: an attempt that happened is never rewritten.


## Test deliveries
`IWebhooksService.TryTestAsync` builds a delivery like any other, with its own random id, the webhook's first event name and a body that says what it is:

```csharp
Data = new WebhookEventData.Test(
    IsTest: true,
    Message: "This is a test delivery from Blouppy. No event occurred.")
```

It goes through the same serialization options, signature and history: a test that took a different path would prove nothing about the real one.


## Retention
`WebhookDeliveryPurgeJob` deletes a settled delivery 30 days after it completed (`WebhookRules.DeliveryRetention`). It runs hourly, since a bulk delete across organizations is never urgent. A pending row is never purged, and deleting a webhook deletes its deliveries (`ON DELETE CASCADE`).

> **_Note:_**  Tell subscribers that events are **not ordered** (they should read the current state from the API) and that a paused webhook **drops** events rather than buffering them.


## Conclusion
A signed webhook is a small contract: a frozen envelope, an HMAC over the timestamp and the body that a subscriber checks in a dozen lines, and a secret shown once and rotated rather than recovered. Behind it, a delivery is a row, not a message, carrying its retry schedule, history and retention.

This is how outgoing webhooks work in [Blouppy Starter](https://starter.blouppy.com/); the [webhooks module's documentation](https://docs.starter.blouppy.com/modules/webhooks/) covers the configuration and how to offer a new event.

## References
- [`HMACSHA256` (Microsoft Learn)](https://learn.microsoft.com/dotnet/api/system.security.cryptography.hmacsha256) — the keyed hash, including the static `HashData`.
- [`CryptographicOperations.FixedTimeEquals` (Microsoft Learn)](https://learn.microsoft.com/dotnet/api/system.security.cryptography.cryptographicoperations.fixedtimeequals) — constant-time comparison of signatures.
- [ASP.NET Core Data Protection (Microsoft Learn)](https://learn.microsoft.com/aspnet/core/security/data-protection/introduction) — the API that encrypts the secrets at rest.
- [Standard Webhooks](https://www.standardwebhooks.com/) — an open specification for webhook signatures, ids and timestamps.
- [Receive Stripe events in your webhook endpoint (Stripe)](https://docs.stripe.com/webhooks) — signature verification and timestamp tolerance in a widely used implementation.
- [Server-Side Request Forgery Prevention Cheat Sheet (OWASP)](https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html) — why the sender checks every address it calls.
- [Quartz.NET documentation](https://www.quartz-scheduler.net/documentation/) — the scheduler behind the sweep and purge jobs.
- [Blouppy Starter documentation: webhooks](https://docs.starter.blouppy.com/modules/webhooks/) — the module's configuration and how to add an event.
