---
templateKey: 'blog-post'
title: 'An anti-corruption layer: keeping GitHub''s vocabulary out of your domain'
date: 2027-01-12T09:00:00.000Z
author: Jimmy Boinembalome
authorimage: /img/jimmy.jpg
category: C#
topic: 'Architecture'
illustration: 3
categorycolor: bg-purple-100 text-purple-800
featuredpost: true
description: >-
  Learn the Anti-Corruption Layer from Domain-Driven Design in C#: how GitHub webhooks become requests in your own domain's terms, and when a direct call is enough.
tags:
  - Development
  - C#
  - Design Patterns
  - DDD
---

An integration with GitHub starts with one webhook. GitHub sends `pull_request` with `"action": "closed"`, a `merged_at` timestamp and a `head.ref`, and the quickest fix is to read them where the issue lives: `if (payload.Action == "closed" && payload.PullRequest.MergedAt is not null) issue.Status = Done;`. A few months later, the issue service knows what a draft is, a status is named after a GitHub event, and adding GitLab means a second set of `if`s in the same class.

In this article, we will look at the **Anti-Corruption Layer**: its definition and shape on a small example, then a real one, the GitHub integration of a project-management app built on [Blouppy Starter](https://starter.blouppy.com/). We will follow a merged pull request from the webhook to a status change, see how an issue code in a branch name is recognised, and finish with the cases where a direct call is the better choice.


## The pattern
The Anti-Corruption Layer comes from Eric Evans' *Domain-Driven Design* (2003), in the strategic design part, next to bounded contexts and context maps. It is not one of the Gang of Four patterns, although it is built from two of their structural ones. Evans describes it as an isolating layer that gives our model the other system's functionality in our model's own terms. The layer talks to the other system through the interface that system already has, and translates in both directions between the two models.

Evans names three parts:

- **A facade** that simplifies the other system's interface to what we use.
- **Adapters** that turn the other system's protocol into calls our code can make.
- **Translators** that turn the other model's concepts into ours.

A minimal version, for a carrier that reports a parcel with status codes:

```csharp
// The carrier's model: codes we do not choose.
internal sealed record CarrierTrackingEvent(string StatusCode, string ParcelRef);

// Ours.
public abstract record ShipmentChange
{
    public sealed record Delivered(ShipmentId ShipmentId) : ShipmentChange;

    public sealed record Lost(ShipmentId ShipmentId) : ShipmentChange;
}

internal static class CarrierTranslator
{
    public static ShipmentChange? Translate(CarrierTrackingEvent trackingEvent, ShipmentId shipmentId)
        => trackingEvent.StatusCode switch
        {
            "DLV" => new ShipmentChange.Delivered(shipmentId),
            "LST" or "RTS" => new ShipmentChange.Lost(shipmentId),
            _ => null
        };
}
```

The shipping domain sees `Delivered` and `Lost`; `DLV` stays in one file.


## Where the layer sits
In the project-management app, three groups of projects take part, and only the middle one knows both languages:

- **`Blouppy.Infrastructure.GitHub`**, the adapters: `GitHubAppWebClient` behind `IGitHubAppWebClient` for the REST API, and `GitHubWebhookVerifier` behind `IGitHubWebhookVerifier` for the `X-Hub-Signature-256` HMAC.
- **`Blouppy.ExternalIntegrations`**, the module that holds the translators and the links between an issue and what a code host sent.
- **`Blouppy.Issues`**, the domain. Its project file references neither of the two above. It learns about a pull request through an integration event that names an issue and a status, nothing else.

The webhook controller in `Blouppy.Web` reads the body once, checks the signature over those exact bytes, and hands a receipt to the module. Signing an HMAC has its [own article](/blog/2026-09-19-signed-outgoing-webhooks-in-aspnet-core/), from the sending side.


## Store the delivery before translating it
GitHub does not retry a failed delivery on its own, so the receiver has to accept fast and never lose what it accepted. The module stores the raw payload as an `InboundDelivery` row and publishes a nudge, and the controller commits both together:

```csharp
var delivery = new InboundDelivery(
    ExternalIntegrationProvider.GitHub,
    deliveryId,
    receipt.Event,
    envelope.Action,
    installationId,
    receipt.Payload);

await inboundDeliveriesRepository.AddAsync(delivery, cancellationToken);

// Held by the bus outbox until the caller's commit: the row and its announcement land together.
await deliveryReceivedPublisher.PublishAsync(
    new InboundDeliveryReceivedIntegrationEvent(delivery.Id),
    cancellationToken);
```

The `X-GitHub-Delivery` id is checked before the insert, so a copy GitHub sends twice is acknowledged and changes nothing. The why of the outbox is in [domain events, integration events and the outbox](/blog/2026-05-28-domain-events-vs-integration-events-and-the-outbox/).

For the layer, this step matters for another reason: **the translation happens later, off the request, from a stored copy**. A translation bug becomes a row marked `Failed` with the exception's message, and an administrator can reprocess it once the code is fixed. Nothing GitHub sent is lost because our side did not understand it yet.


## Read only what the layer needs
A GitHub payload carries hundreds of fields. The module declares, per event, a record with the few it reads, and `GitHubPayload.Read<T>` deserializes with `JsonNamingPolicy.SnakeCaseLower`, skipping the rest:

```csharp
internal sealed record GitHubPullRequest(
    long Id,
    int Number,
    string HtmlUrl,
    string Title,
    string? Body,
    string State,
    bool Draft,
    DateTimeOffset? MergedAt,
    GitHubBranchReference Head,
    GitHubBranchReference Base)
{
    public bool IsOpen
        => State == "open";

    public bool IsMerged
        => MergedAt is not null;

    public PullRequestReference MapToReference(GitHubRepositoryReference repository)
        => new(
            new ExternalItemId(Id.ToString(CultureInfo.InvariantCulture)),
            new ExternalItemNumber(Number),
            HtmlUrl,
            Title,
            Body,
            Head.Ref,
            IsMerged
                ? ExternalItemState.Merged
                : IsOpen
                    ? ExternalItemState.Open
                    : ExternalItemState.Closed,
            RevertedNumberIn(repository));
}
```

The merge is read from `merged_at` because the `pull_request_review` event sends a shorter pull request without a `merged` field. That kind of detail is exactly what the layer exists to absorb. `MapToReference` is the first translator: `"open"` and a timestamp become `ExternalItemState`, and `head.ref` becomes a plain `HeadBranch`. `RevertedNumberIn` reads the `Reverts owner/repo#N` line that GitHub's *Revert* button writes into the body.


## Translate an action into a step
Next, a GitHub action becomes a step in the life of a pull request, in the module's vocabulary. `PullRequestEventHandler` answers `X-GitHub-Event: pull_request` and turns the action into `AutomationTrigger` values:

```csharp
internal static IReadOnlyCollection<AutomationTrigger> TriggersOf(string action, GitHubPullRequest pullRequest)
    => action switch
    {
        "opened" when pullRequest.Draft => [AutomationTrigger.PullRequestDraftOpened],
        "opened" or "ready_for_review" or "reopened" => [AutomationTrigger.PullRequestOpened],
        "review_requested" when pullRequest.IsOpen => [AutomationTrigger.PullRequestReviewActivity],
        "closed" or "edited" when pullRequest.IsMerged => [AutomationTrigger.PullRequestMerged],
        "edited" when pullRequest.IsOpen && pullRequest.Draft => [AutomationTrigger.PullRequestDraftOpened],
        "edited" when pullRequest.IsOpen => [AutomationTrigger.PullRequestOpened],
        _ => []
    };
```

`"closed"` alone means nothing: a pull request closed without a merge moves no issue. `AutomationTrigger` has no GitHub word in it, and its documentation says *whatever the code host*. A GitLab merge request reaching the same states would produce the same triggers.

`GitHubEventRouter` finds one `IGitHubEventHandler` per event name, and an event with no handler is recorded `Ignored`.


## Recognise an issue code
A pull request is linked to an issue by its code, such as `MOB-12`, found in the title, the body or the head branch. `IssueCodeParser` lives under `SourceControl/` because GitLab names its merge requests the same way. It is given the code of the one project the repository is linked to, since a project code is not unique across an organization:

```csharp
// GitHub's own closing keywords, so the habit a team has on GitHub carries over.
private const string ClosingKeyword = "(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)";

// A letter or a digit on either side means another word, so a code is never found inside a longer one.
private static string CodePattern(Code projectCode)
    => $@"(?<![\p{{L}}\p{{N}}]){Regex.Escape(projectCode.Value)}-(?<number>[1-9][0-9]{{0,8}})(?![\p{{L}}\p{{N}}])";
```

The rules it applies:

- `XMOB-12`, `MOB-123`, `MOB-12a` and `MOB-012` do not name `MOB-12`. Case is ignored, so `mob-12-offline-sync` is a branch for `MOB-12`.
- `Fixes MOB-12` or `Fixes: MOB-12` in the title or body is a **closing** reference, and so is any code in the head branch. A code alone is a **mention**. A closing reference anywhere wins.
- Every regular expression has a one-second match timeout, because the text is anybody's pull request body.

`CodeReferenceLinker` then keeps one `ExternalItemLink` row per issue the pull request names, with its title, URL, state and reference, and deletes the row of an issue an edit took out. A mention links and moves nothing. A revert only mentions what it names, since its title repeats the reverted one, keywords included.


## Ask the domain in its own terms
The last translation turns a trigger into a request the Issues domain understands. `AutomationResolver` reads the automation rules (by default, a merged pull request sends an issue to the first status of the *Done* category) and, for a Kanban issue, publishes this:

```csharp
public sealed record IssueStatusChangeRequestedIntegrationEvent(
    IssueId IssueId,
    ProjectStatusId StatusId,
    bool MayMoveBack) : IIntegrationEvent;
```

There is no pull request, no repository and no provider in it. The GitHub handlers never name a status: the resolver picks one from the rules of the project, its workspace or its organization, or the defaults. And the module never writes an issue. `GitHubPullRequestLinker` also holds back a merge while another pull request closing the same issue is still open.

On the other side, a handler in `Blouppy.Issues` decides whether the move happens, with the rules that belong to the issue:

```csharp
internal sealed class ChangeStatusWhenIssueStatusChangeRequestedIntegrationEventHandler(
    IIssuesService issuesService,
    IIssuesRepository issuesRepository,
    IParentIssueRollup parentIssueRollup,
    IProjectsPublicDataService projectsPublicDataService,
    IActorScope actorScope,
    IUnitOfWork unitOfWork) : IIntegrationEventHandler<IssueStatusChangeRequestedIntegrationEvent>
{
    public async Task HandleAsync(
        IssueStatusChangeRequestedIntegrationEvent @event,
        CancellationToken cancellationToken = default)
    {
        var searchIssue = await issuesRepository.TryGetAsync(@event.IssueId, cancellationToken);

        if (searchIssue.NotFound || searchIssue.Value.ProjectStatusId == @event.StatusId)
        {
            return;
        }

        if (!await MayMoveAsync(searchIssue.Value.ProjectStatusId, @event, cancellationToken)
            || await parentIssueRollup.FollowsSubIssuesAsync(searchIssue.Value, cancellationToken))
        {
            return;
        }

        using var _ = actorScope.ActAsExternalIntegration();

        var result = await issuesService.TryChangeStatusAsync(
            new IssueStatusEdition(@event.IssueId, @event.StatusId),
            cancellationToken);

        if (result.Succeeded)
        {
            await unitOfWork.CommitAsync(cancellationToken);
        }
    }
}
```

The issue moves forward only, unless `MayMoveBack` says the code host is the authority. A parent that follows its sub-issues is left alone. The change goes through `IIssuesService`, the same driving port a person uses, with its validation, under a system actor, so the activity feed records who moved the issue. The handler checks the current status first, which makes a redelivered message harmless (more in [idempotent message handlers](/blog/2026-08-20-idempotent-message-handlers-with-deterministic-ids/)).


## SourceControl/ and GitHub/
Inside the module, the folders follow the vocabulary:

- **The root** holds what every provider shares: `ExternalIntegration` (an organization's connection) and `InboundDelivery`.
- **`SourceControl/`** holds what code hosts have in common: `RepositoryLink`, `ExternalItemLink`, `IssueCodeParser`, `CodeReferenceLinker`, `PullRequestReference`, the automation rules and their resolver.
- **`GitHub/`** holds what only GitHub speaks: `GitHubPullRequest`, the event names, `TriggersOf`, the revert line.

This split is a second, inner boundary. `CodeReferenceLinker` takes a `PullRequestReference`, never a `GitHubPullRequest`, so it cannot read a GitHub field by accident. Adding GitLab means a `GitLab/` folder that maps its payloads into the same references and triggers, and nothing under `SourceControl/` or in Issues changes.


## When a direct call is enough
The layer pays off when three things are true at once:

- **We do not control the other model.** GitHub decides its payloads, its event names and when they change.
- **Its language differs from ours.** A pull request is not an issue, and `closed` does not mean *done*.
- **It is likely to change, or to have siblings.** Another code host, another payload version.

When one of them is missing, a thinner seam is enough. The [billing module](/blog/2026-10-01-billing-module-behind-an-adapter/) hides Stripe behind one `IPaymentGateway` port and maps a few event types in its adapter. That port is already a small translator, and a whole module would add nothing. A service that our own team owns and that shares our vocabulary can be called directly through a typed `HttpClient`. And for a one-off script that reads three fields of an API, a record with those three fields is the whole layer.

Evans also lists the alternatives. When the other model is good enough and our team has no leverage, the **conformist** relationship adopts it as it is. When the integration brings too little value, **separate ways** drops it. The layer is the choice when the integration matters and the other model would bend ours.


## What it costs
- **More code.** A pull request event goes through a controller, a stored delivery, a handler, a payload record, a reference, a linker, a resolver, an integration event and a handler in Issues. A direct call would be ten lines.
- **Mapping, and duplicated concepts.** `ExternalItemState` repeats GitHub's states, `AutomationTrigger` repeats its actions. Each duplicate has to be kept in line when the other side evolves, and each mapping needs tests.
- **Latency.** The issue moves after the delivery is stored, the message consumed and the request handled. A person watching the board sees it move a moment after the merge, never during the request.
- **Two places to look.** A move that did not happen can be refused in the module (a mention, a closed pull request, another one still open) or in Issues (already further along, a parent that follows its sub-issues). Both sides log the reason, and the delivery history shows what arrived.


## Conclusion
An anti-corruption layer is a translation that we choose to own. In the project-management app, GitHub's vocabulary stops at the module: the controller stores what arrived, `GitHubPullRequest` reads the few fields we need, `TriggersOf` turns an action into a step, `IssueCodeParser` finds `MOB-12` in a branch name, and Issues receives a request to change a status. Its project file never mentions GitHub.

The price is real, so it is worth paying only for a model we do not control, that speaks another language and keeps changing. For anything else, a port, a typed client or a record with three fields does the job.


## References
- [Domain-Driven Design: Tackling Complexity in the Heart of Software (Eric Evans)](https://www.domainlanguage.com/ddd/) — the book that names the Anti-Corruption Layer, conformist and separate ways.
- [Domain-Driven Design Reference (Eric Evans)](https://www.domainlanguage.com/ddd/reference/) — the short summary of each pattern, context mapping included.
- [Anti-corruption Layer pattern (Microsoft Learn)](https://learn.microsoft.com/azure/architecture/patterns/anti-corruption-layer) — the pattern applied between services, with its trade-offs.
- [Bounded Context (Martin Fowler)](https://martinfowler.com/bliki/BoundedContext.html) — why two models of the same thing coexist.
- [Webhook events and payloads (GitHub Docs)](https://docs.github.com/webhooks/webhook-events-and-payloads) — the `pull_request` event and its actions.
- [Validating webhook deliveries (GitHub Docs)](https://docs.github.com/webhooks/using-webhooks/validating-webhook-deliveries) — the `X-Hub-Signature-256` HMAC.
- [Linking a pull request to an issue (GitHub Docs)](https://docs.github.com/issues/tracking-your-work-with-issues/using-issues/linking-a-pull-request-to-an-issue) — the closing keywords the parser reuses.
- [Regular expression source generators (Microsoft Learn)](https://learn.microsoft.com/dotnet/standard/base-types/regular-expression-source-generators) — `GeneratedRegex`, used for the revert line.
- [Blouppy Starter](https://starter.blouppy.com/) — the starter kit the app is built on.
