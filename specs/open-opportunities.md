# Open Opportunities and Later Proposals

**Status:** Experimental proposal for AdCP 3.3 (feature id `media_buy.open_opportunities`)

**Target:** AdCP 3.3
**RFC:** [#8096](https://github.com/adcontextprotocol/adcp/issues/8096)

This is the design record for RFC #8096. The normative text lives in
[Open opportunities and later proposals](../docs/media-buy/product-discovery/proposal-negotiation.mdx#open-opportunities-and-later-proposals)
and [`list_proposals`](../docs/media-buy/task-reference/list_proposals.mdx).
Everything ships under the [experimental status contract](../docs/reference/experimental-status.mdx).

## Problem

Publishers want to bring a buyer demand they could not include in the first
response: an answer from a sales desk that takes hours, a revision of their own
offer, or inventory that opened up ahead of an event. Today they do it by
email. AdCP 3.2 has the pieces (a buyer-assigned `opportunity`, immutable
proposals with lineage, account-anchored notifications, the account change
feed) but four gaps:

1. No consent and no window. `response_deadline` is optional and silent about
   anything after the response.
2. No delivery path after the creating task completes. `push_notification_config`
   belongs to one task, and the `NotificationType` rules forbid using it for
   persistent account-anchored events.
3. No proposals read. Proposals exist only in `request_proposals` and
   `refine_proposals` responses, so a missed delivery cannot be repaired and
   the change feed has no repair read for them.
4. The first purchase closes the opportunity, because `accept_proposal` and
   `buy_products` only accept `status: "closed"` and infer closure.

## Design

| Part | Capability | Surface |
| --- | --- | --- |
| Read | `open_opportunities.list_proposals` | `list_proposals`, `proposal-disposition` enum |
| Keep open | `open_opportunities.keep_open_after_purchase` | `opportunity.status: "open"` on `accept_proposal`, `buy_products` |
| Later proposals | `open_opportunities.later_proposals` (+ `max_open_duration`) | `opportunity.later_proposals`, `later-proposals-state`, `proposal.created`, `later-proposal-reason`, change-feed `proposal` records, empty `declines` with `opportunity` |

Parts are advertised separately because they are useful separately: buyers
adopt a proposals read and multi-step buying before they adopt seller-initiated
proposals. `later_proposals` requires `list_proposals`, its repair read.

### Consent rather than a deadline

`response_deadline` keeps its 3.2 meaning (the creating task's response). A
separate `later_proposals.until` ends the later window, so a buyer can ask for
an answer in 60 seconds and still accept later proposals for a month. Consent
is explicit and defaults to none; an absent deadline never implies it. The
buyer can cap volume (`max_count`, `min_interval`). The window always ends,
because sellers that support later proposals must advertise
`max_open_duration`.

Consent sits on the shared `OpportunityContext`, so defaults follow the
existing `status` rule: absence means none at creation and unchanged after.

### Account-anchored invalidation, not a task webhook

`proposal.created` is account-anchored, identifiers-only, and repaired through
`list_proposals`. It follows the existing `account.change_recorded` and
`principal.changed` pattern. Identifiers only means a forged or replayed body
cannot inject terms, and seller prose reaches a buyer agent only through an
authenticated read.

### Snapshot plus disposition

Proposals are immutable and `proposal_status` has no declined or expired
state, so `list_proposals` returns the snapshot unchanged and puts lifecycle
state beside it. `disposition` was chosen over `state` or `status` to avoid
collisions with `proposal_status` and `opportunity.status`. `superseded` was
left out because 3.2 refinement does not retire its source.

## Alternatives considered

- **Carry it on `get_products`.** `get_products` is deprecated in 3.2. Consent
  lives on `OpportunityContext`, so it reaches `get_products` automatically if
  #7902 adds the core `opportunity` field there; nothing else is needed.
- **A webhook on the opportunity.** It would need a fourth notification anchor
  and a way to rotate and pause it. Account subscriptions already provide both.
- **Principal-scoped opportunities.** The creating principal is usually a buyer
  agent, not the operator; scoping to it strands opportunities when an agent is
  replaced. Account scope matches other account reads, and `updated_at` on the
  recorded consent exposes changes made by another principal.
- **Ride only on the account change feed.** The feed is experimental and
  optional, so most buyers would have to poll. A dedicated notification works
  without it; sellers on the feed also record `proposal` changes.
- **Post-purchase `media_buy_update` later proposals.** Unsolicited changes to a
  live buy are a different consent and a finance-reconciliation burden.
  Deferred.

## Review notes

Protocol, product, security, and developer-experience reviews shaped the
current text: the separate `until` (deadline semantics unchanged), structured
buyer limits, draft-only and `expires_at` rules, the consent echo, consent
reset on purchase, the governance rule, identifiers-only payloads, untrusted
seller text, the `withdrawn`-committed rule, the version gate on change-feed
records, the capability split, and the test-controller scenario.

## Resolved questions

These were open in the first draft of #8096. The PR proposes the answers below;
the working group can overturn them.

- **Default limits.** When the buyer gives consent without limits, the
  protocol defaults apply: `max_count` 5 and `min_interval` 1 day. Sellers may
  be stricter, never looser, and the echo states the limits in force. This
  makes "not annoying" a protocol guarantee that conformance can test, rather
  than seller policy.
- **Retention.** Snapshots stay readable through `list_proposals` while
  available and for at least 30 days after a terminal disposition. Accepted
  terms remain on `get_media_buys` after that. Older change-feed records repair
  with `available: false` and `unavailable_reason: "deleted"`.
- **Withdrawal notification.** None. Only drafts can be withdrawn, and a draft
  cannot be accepted, so a buyer that learns late loses nothing. Refining or
  accepting a withdrawn snapshot fails with `INVALID_STATE`, as for a declined
  one, and sellers on the change feed record the status change.
- **Seller governance at creation.** None. A later proposal has no
  `governance_context` of its own and must not borrow the original request's,
  so the only meaningful check is at acceptance, where the buyer supplies one.

## Graduation

Graduation follows the experimental contract: cross-party validation (a second
implementation or a production buyer integration), 30 days without open
breaking-change issues, and a storyboard that drives `simulate_later_proposal`
through consent, limits, notification, change-feed record, and
`list_proposals`.
