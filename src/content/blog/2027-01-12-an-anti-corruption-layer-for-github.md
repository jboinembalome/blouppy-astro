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

An integration with GitHub starts with one webhook. GitHub sends `pull_request` with `"action": "closed"` and a `merged_at` timestamp, and the quickest fix is to read them where the issue lives: `if (payload.Action == "closed" && payload.PullRequest.MergedAt is not null) issue.Status = Done;`. A few months later, the issue service knows what a draft is, a status is named after a GitHub event, and adding GitLab means a second set of `if`s in the same class.

An **Anti-Corruption Layer** keeps that vocabulary out.


## The pattern
The Anti-Corruption Layer comes from Eric Evans' *Domain-Driven Design*, in the strategic part, next to bounded contexts. Evans describes it as an isolating layer that gives our model the other system's features in our model's own terms. It talks to the other system through the interface that system already has, and translates between the two models. Inside it, he names a facade, adapters and translators. The translators are the heart of it.

A project-management app built on [Blouppy Starter](https://starter.blouppy.com/) has one for GitHub. Three groups of projects take part, and only the middle one knows both languages:

- **An adapter project** calls GitHub's REST API and checks the webhook's `X-Hub-Signature-256`.
- **An integrations module** holds the translators.
- **The Issues domain** references neither. It learns about a pull request through an integration event that names an issue and a status, nothing else.

Let us follow a merged pull request through it.


## Store first, translate later
GitHub does not retry a failed delivery on its own, so the receiver has to accept fast and never lose what it accepted. The controller checks the signature, the module stores the raw payload as a delivery row, and the controller answers `202 Accepted`. The `X-GitHub-Delivery` id is checked first, so a copy sent twice changes nothing.

For the layer, this matters for another reason: the translation happens later, off the request, from a stored copy. A translation bug becomes a row marked `Failed`, and an administrator reprocesses it once the code is fixed. Nothing GitHub sent is lost because our side did not understand it yet.


## Read only what is needed
A GitHub payload carries hundreds of fields. The module declares a record per event with the few it reads, and skips the rest (trimmed):

```csharp
internal sealed record GitHubPullRequest(
    long Id,
    int Number,
    string Title,
    string? Body,
    string State,
    bool Draft,
    DateTimeOffset? MergedAt,
    GitHubBranchReference Head)
{
    public bool IsOpen => State == "open";

    public bool IsMerged => MergedAt is not null;
}
```

The merge is read from `merged_at` because the `pull_request_review` event sends a shorter pull request without a `merged` field. That kind of detail is exactly what the layer exists to absorb. A first translator then maps this record to a provider-neutral reference: `"open"` and a timestamp become an `ExternalItemState`, and `head.ref` becomes a plain head branch.


## Translate an action into a step
Next, a GitHub action becomes a step in the life of a pull request, in the module's own words:

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

`"closed"` alone means nothing: a pull request closed without a merge moves no issue. And `AutomationTrigger` has no GitHub word in it. A GitLab merge request reaching the same states would produce the same triggers.

The pull request is linked to an issue by its code, such as `MOB-12`, found in the title, the body or the branch name. `Fixes MOB-12`, with GitHub's own closing keywords, is a closing reference, and so is a code in the branch. A code alone is a mention, which links and moves nothing. `XMOB-12` and `MOB-123` do not name `MOB-12`.


## Ask the domain in its own terms
The last translation turns a trigger into a request the Issues domain understands. A resolver reads the automation rules (by default, a merged pull request sends an issue to the first *Done* status) and publishes:

```csharp
public sealed record IssueStatusChangeRequestedIntegrationEvent(
    IssueId IssueId,
    ProjectStatusId StatusId,
    bool MayMoveBack) : IIntegrationEvent;
```

No pull request, no repository, no provider. And the module never writes an issue.

On the other side, a handler in the Issues domain decides whether the move happens, with the issue's own rules. The issue moves forward only, unless `MayMoveBack` says the code host is the authority. A parent issue whose status follows its sub-issues is left alone. The change goes through the same service a person uses, with its validation, under a system actor, so the activity feed says who moved it. And since the handler checks the current status first, a redelivered message is harmless.

Inside the module, the folders follow the vocabulary. `SourceControl/` holds what code hosts share: links, references, the code parser, the automation rules. `GitHub/` holds what only GitHub speaks: the payload records, the event names, `TriggersOf`. The shared code takes a neutral reference, never a `GitHubPullRequest`, so it cannot read a GitHub field by accident. GitLab would be a `GitLab/` folder, and nothing in Issues would change.


## When a direct call is enough
The layer pays off when three things are true at once. We do not control the other model. Its language differs from ours: a pull request is not an issue, and `closed` does not mean *done*. And it is likely to change, or to have siblings.

When one is missing, a thinner seam is enough. The Starter's [billing module](/blog/2026-10-01-billing-module-behind-an-adapter/) hides Stripe behind one payment port that maps a few event types; a whole layer would add nothing. A service our own team owns can be called through a typed `HttpClient`. Evans also names the alternatives: **conformist** adopts the other model as it is, and **separate ways** drops the integration.

The price is real. A merged pull request goes through a stored delivery, a handler, a payload record, a reference, a resolver, an integration event and a handler in Issues, where a direct call would be ten lines. Concepts are duplicated and must be kept in line. And when an issue did not move, the reason can be on either side of the layer.


## References
- [Domain-Driven Design Reference](https://www.domainlanguage.com/ddd/reference/) — Eric Evans' summary of each pattern, context mapping included.
- [Anti-corruption Layer pattern](https://learn.microsoft.com/azure/architecture/patterns/anti-corruption-layer) — Microsoft Learn: the pattern between services, with its trade-offs.
- [Webhook events and payloads](https://docs.github.com/webhooks/webhook-events-and-payloads) — GitHub Docs: the `pull_request` event and its actions.
- [One handler per event: routing GitHub webhooks](/blog/2027-01-07-one-handler-per-event-routing-github-webhooks/) — how each event finds its handler.
