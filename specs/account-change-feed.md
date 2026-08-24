# Account Change Feed

**Status:** Nonnormative draft pending RFC ratification

**Target:** AdCP 3.2
**RFC:** [#6810](https://github.com/adcontextprotocol/adcp/issues/6810)

This document is the implementation draft for RFC #6810. It MUST NOT be
treated as an accepted protocol requirement until the RFC completes the
required review period and has an accepted decision record.

## Problem

An advertiser account is rarely controlled by one buyer agent. A seller
operator, another authorized principal, seller automation, or a connected
platform can create and modify campaigns, creatives, budgets, account state,
and reporting without a preceding task from the observing buyer.

AdCP has four different concepts today:

1. authoritative reads describe current state;
2. task responses acknowledge one requested operation;
3. webhooks notify selected changes or deliver reporting data; and
4. `webhook_activity[]` records delivery attempts for debugging.

None is a durable, ordered account-wide record of material business-state
changes. `get_media_buys.history[]` is bounded and buy-specific, task history
does not contain out-of-band changes, and webhook delivery can be missed.

The result is a convergence gap: a buyer connecting to an existing shared
account cannot mechanically establish what is true now and what changed while
it was offline.

## Normative invariant

For every committed material change to account-scoped control-plane state
designated by an authoritative AdCP read, a seller supporting the account
change feed MUST:

1. reflect the resulting current state on that authoritative read regardless
   of whether the change originated through AdCP, a seller UI or API, seller
   automation, another authorized principal, or a connected platform;
2. append one immutable account change record in the same commit boundary;
3. make the authoritative snapshot and change record readable before
   enqueueing a notification; and
4. fan out `account.change_recorded` to every active account subscriber that
   explicitly requested that event type.

A synchronous task response does not suppress the change notification. The
account can have other subscribers and authorized principals that did not
invoke the task.

This is not event sourcing. Current state remains authoritative on the named
read, while a change record proves that a material transition was recorded and
points at the repair read. Deletion records are durable tombstones because the
current-state read cannot recover a deleted resource.

### Included changes

Material changes include resource creation or discovery, lifecycle state,
spend and delivery controls, flights, targeting, creative content and
assignment, account access and status, financial state, reporting corrections
and finality, and deletion or purge markers when those fields are part of a
covered authoritative read.

### Excluded observations

The following do not produce account change records:

- reads, previews, and dry runs;
- validation failures and operations that do not commit;
- exact idempotency replays;
- no-op connector polls and timestamp-only reevaluations;
- webhook delivery attempts;
- impression-level delivery counter accumulation;
- raw audience members, raw catalog item bodies, and raw logged events; and
- internal optimization decisions that stay within an already-authorized
  control envelope and do not alter a covered current-state field.

A reporting correction, finality transition, budget-control change, or other
material revision is included even though routine counter accumulation is not.

## Authoritative coverage matrix

The following table is normative for sellers that advertise the corresponding
resource type in `account.change_feed.resource_types`. “Source-neutral” means
membership and state depend on caller access, never on whether AdCP created the
resource.

| Resource family | Authoritative current-state read | 3.2 requirement |
| --- | --- | --- |
| Account identity, status, authorization, billing configuration | `list_accounts` | Complete current state; source-neutral changes recorded. |
| Account spend, credit, payment, invoices | `get_account_financials` | Complete when account financials and this resource type are advertised. |
| Media buys and packages | `get_media_buys` | Every caller-visible account buy, including external creation and modification; buyers enumerate every status and page. |
| Delivery and reporting | `get_media_buy_delivery` | Current results within declared parity; corrections, adjustment, and finality revisions recorded. Routine metric increments are excluded. |
| Creative library | `list_creatives` | Every caller-visible creative regardless origin, with current content revision or digest and lifecycle state. |
| Creative assignment and approval | `get_media_buys`; optional reverse projection on `list_creatives` | Exact current relationship and approval; changes recorded. |
| Audiences | `sync_audiences` discovery mode | Native/connected identity, management origin, and current revision are required before a seller advertises audience coverage. Raw members never enter the feed. |
| Event sources | `sync_event_sources` discovery mode | Buyer- and seller-managed sources are source-neutral and changes are recorded. |
| Catalogs | `sync_catalogs` discovery mode | Native/connected identity, management origin, and current revision are required before catalog coverage is advertised. Item bodies do not enter the feed. |
| Wholesale products and signals | `list_products` / `get_signals` | Existing versioned feeds stay authoritative. Account changes record control or bulk revisions rather than duplicating every feed entity body. |

An implementation MUST NOT advertise a resource type whose current material
state cannot be recovered through its named read. Inline-only creative bodies,
native audience/catalog identities, and opaque mutable package fields are
known specification gaps to close before claiming coverage; the change feed
does not paper over them.

## `list_account_changes`

`list_account_changes` is an optional, read-only task. It is exposed only when
`account.change_feed.supported` is true.

### Request

The request contains one required `account` and accepts:

- `cursor`: opaque checkpoint from a prior call;
- `starting_position`: `earliest` or `latest`, valid only without `cursor`;
- `resource_types`: optional exact filter; and
- `max_results`: 1–100, default 50.

`earliest` is the default initial position and starts at the oldest retained
record. `latest` returns a checkpoint at the seller's current ingestion
high-water. A cursor is bound to authenticated principal, resolved account,
and normalized filter set and MUST NOT be reusable under another scope.

### Response

The response contains:

- `changes[]`, ordered oldest first;
- `cursor`, always present even when `changes[]` is empty;
- `has_more`;
- `available_since`;
- `generated_at`; and
- optional account-specific `source_coverage[]` watermarks.

This task deliberately does not use `pagination-response.json`: ordinary
pagination omits a cursor at the tail, while a tailing feed requires a durable
empty-page checkpoint.

### Cursor rules

Cursor order is a total account order independent of timestamps. A cursor
means strictly after its scanned high-water. Appends never reorder previously
returned pages. A filtered page advances across nonmatching records, and an
empty page advances to the current scanned high-water.

If a cursor falls outside retention, the seller MUST return
`CURSOR_EXPIRED`. It MUST NOT silently restart from the retention boundary.
The error is `correctable`; recovery is to acquire a new latest checkpoint,
rebuild authoritative snapshots, and drain from that checkpoint.

The seller retains account changes for at least 90 days after recording.
`available_since` publishes the actual retained boundary. Sellers do not
fabricate history from before adopting the feed.

### Race-free bootstrap

1. Discover `account.change_feed` and the account's current source coverage.
2. Register `account.change_recorded` on `sync_accounts`.
3. Call `list_account_changes(starting_position: "latest")` and persist C0.
4. Enumerate every authoritative account snapshot, including every lifecycle
   status rather than active-only defaults.
5. Drain changes after C0 and reread the resources they name.
6. On each signed notification, drain from the persisted cursor again.
7. Poll periodically so webhook loss cannot create a permanent gap.
8. On `CURSOR_EXPIRED`, repeat the bootstrap.

Changes committed while step 4 is in progress appear after C0, closing the
multi-read bootstrap race.

## Change record

Every `account-change.json` record has:

- stable `change_id`;
- seller `recorded_at` and optional trustworthy upstream `occurred_at`;
- structured resource type, account, ID, and optional parent IDs;
- open `action`, with standard values `created`, `discovered`, `updated`,
  `status_changed`, `linked`, `unlinked`, `deleted`, and `purged`;
- server-derived origin kind;
- an allowlisted read-only `repair.task` hint. Buyers construct and validate
  arguments locally from the authenticated account and resource identity and
  never dispatch feed data directly; and
- optional revision, changed JSON Pointer paths, redaction-safe actor, reason,
summary, and bounded extension metadata.

Each encoded record is limited to 64 KiB, with at most 64 changed paths and 20
extension namespaces. IDs, paths, summaries, reasons, actor labels, and
extensions are untrusted seller input: buyers do not interpolate them into
system prompts, execute them, or use them as authorization evidence.

Unknown resource and action values remain processable as generic
invalidations. Change records never carry credentials, setup tokens, bank
details, raw audience members, raw logged events, webhook bodies, internal
stack traces, or unbounded before/after snapshots.

For a deletion or compelled legal purge, the record keeps only a non-sensitive
identity, time, category, and repair disposition. If law requires removing
even that metadata, the seller documents the legal exception and MUST NOT
represent the affected interval as complete.

## `account.change_recorded`

The notification is account-anchored and registered through
`sync_accounts.accounts[].notification_configs[]`. Each committed change
produces one logical notification per subscribed endpoint.

The payload carries `account_id`, `change_id`, resource identity, action,
`recorded_at`, and an optional advisory `through_cursor` target.
`notification_id` equals `change_id`. Transport retries reuse the same
`idempotency_key`; deliberate re-emission uses a new delivery key with the
same logical notification ID.

The payload is an invalidation, not current state. A receiver MUST NOT install
`through_cursor` without reading intervening feed pages. Existing specialized
notifications remain valid and can overlap the generic change notification.

## Connected-source coverage

The seller-wide capability lists resource types the seller can support.
`list_account_changes.source_coverage[]` reports account-specific source
health with a source kind, status, resource types, optional coverage start,
last successful sync, and observed-through watermark.

`has_more: false` means the caller is caught up to seller ingestion. It does
not mean an unavailable upstream platform has been observed through the
present. A seller may report a connection as delayed or unavailable; it may
not silently omit connected resources while reporting current coverage.

## Authorization and privacy

Current authorization controls both snapshots and history. Sellers filter
inaccessible resource changes without revealing their existence or count, but
still advance the scoped cursor across filtered records. Cursors are bound to
the authenticated principal to prevent cross-principal reuse.

Subscriber authorization is rechecked when each notification is fired. Losing
account access immediately suspends or removes that principal's subscriptions;
a previously accepted endpoint is not a permanent grant.

Actor metadata is server-derived and privacy-redactable. The feed is not a
substitute for a security audit or user-activity log. `origin` and `actor` are
seller assertions, not independent provenance, and MUST NOT grant access,
establish nonrepudiation, or bypass buyer policy checks. The feed does not
include logins, failed actions, or webhook transport attempts.

## Conformance requirements

Capability-gated conformance MUST test:

1. out-of-band create, update, status, relationship, correction, and deletion
   appear on both the source-neutral snapshot and the change feed;
2. snapshot and change record are readable before webhook enqueue;
3. AdCP, seller-operator, seller-system, connected-platform, and
   other-principal origins produce records;
4. no-op, failed, dry-run, and exact idempotency replay calls do not;
5. total ordering, timestamp ties, pagination, concurrent appends, filters,
   empty-tail checkpoints, expiry, and rebootstrap are gap-free;
6. subscriber activation, fan-out, retry and re-emission identity, and
   specialized-notification overlap behave as specified;
7. cross-account and cross-principal isolation, actor redaction, and absence of
   secrets and PII; and
8. retention and connected-source freshness match advertised values.

Failure of a test for an advertised resource type is a failure, not a silent
skip.

## Training scenario

The public training seller exposes an existing shared sandbox account. A
generic connected-platform simulator adds and later modifies a creative
without a learner AdCP creative call. The reference seller advertises only
`creative` coverage until campaign, money, assignment, and reporting mutation
paths pass the same completeness tests. The learner:

1. registers the account change subscriber;
2. obtains C0 and snapshots the shared account;
3. observes signed external-create and external-modification notifications;
4. drains the feed after each wake-up; and
5. repairs the named authoritative reads.

The exercise teaches that the account is not exclusively managed by the buyer
and that a webhook is a wake-up, not the source of current truth.

## Compatibility and rollout

This is an additive optional wire surface but a new normative behavior for a
seller that advertises it. It therefore targets 3.2, not a 3.1 patch.

Older clients receive no new event implicitly. Sellers emit
`account.change_recorded` only after explicit 3.2 capability negotiation and
explicit subscription. The task is absent when unsupported.

The draft requires schema, documentation, SDK generation, compliance,
training-agent, and certification changes. Merge remains blocked on RFC #6810
ratification.

## Alternatives

### Strengthen snapshots and webhooks without a feed

This enables eventual convergence through full scans, but cannot answer what
changed, preserve deletion markers, or recover a missed notification without
another full scan.

### Reuse `webhook_activity[]`

Rejected. It is a bounded transport-attempt debug log scoped to delivered
webhooks, not a business-state history.

### Reuse resource or task history

Rejected. Buy history is bounded and per-buy; task history misses seller UI,
automation, connected-platform, and other-principal changes.

### Add a specialized webhook for every transition

Specialized notifications remain useful, but a closed set of webhook types
cannot provide durable cursor recovery and grows for every resource family.

### Name the task `list_account_activity`

Rejected because activity implies reads, logins, failures, and transport
attempts and collides with `webhook_activity`. `list_account_changes` states
the bounded invariant directly.
