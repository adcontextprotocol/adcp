---
"adcontextprotocol": minor
---

Creative-lifecycle webhooks (#2261) lands **#4582 track 3** (per-account subscription model) by making `sync_accounts` the universal account-state write surface — no new tool. Governance and notifications are separate concerns: `sync_governance` remains governance-only; `sync_accounts` carries `notification_configs[]` for webhook subscribers.

**Events**

- `creative.status_changed` — fires on every seller- or system-initiated status transition: `processing → rejected`, `pending_review → approved`/`rejected`, `approved → pending_review` (re-review), `approved → rejected` (post-approval revocation), `approved → archived` (seller-initiated). Buyer-initiated transitions do NOT fire — acknowledged on the `sync_creatives` response path. Payload: `creative/creative-status-changed-webhook.json`. `transition.from` is narrowed to `{processing, pending_review, approved}` — post-terminal states never appear there.
- `creative.purged` — fires when a creative is destroyed (retention, takedown, advertiser request, legal erasure, account closure). Soft purges retain a tombstone on `list_creatives` for 30 days; hard purges leave no record (sanctioned Rule 4 carve-out for legal erasure). No coalescence permitted. Payload: `creative/creative-purged-webhook.json`.

**Subscription model — `sync_accounts` polymorphic key**

`sync_accounts` now supports two modes via `oneOf` on each per-account entry:

- **Provisioning mode** — flat `brand` + `operator` + `billing` (today's shape, unchanged). Implicit-account sellers provision/upsert.
- **Settings-update mode** — `account` (AccountRef) keyed by `account_id` (explicit) or natural key (implicit). No provisioning side effects. Sellers that don't implement either mode reject with `UNSUPPORTED_PROVISIONING`. Explicit-account sellers (DV360-class) gain a single focused write surface for account-level settings.

Both modes accept `notification_configs[]` (replace semantics — omit to leave unchanged, `[]` to remove all). Each entry has:
- `subscriber_id` (required, unique per account — no conditional required-when-multiple rules)
- `url`, `event_types[]`, optional legacy `authentication`, `active`
- Sellers MUST reject `event_types[]` containing media-buy-anchored types (forward rule: "any type whose contract anchors at a media buy or below")

`list_accounts` echoes `notification_configs[]` per account with credentials redacted (write-only).

**Governance unchanged**

`sync_governance` keeps its original surface and scope. Governance agents are **not** implicitly subscribed to webhooks. A governance team that wants creative-lifecycle fires registers its URL as a separate `notification_configs[]` entry on `sync_accounts` — explicit, auditable, filterable via `event_types[]`. No foot-gun where governance endpoints get force-fed signals they aren't built to ingest.

**Self-serve buyers**

A buyer who wants webhooks but no governance: just `sync_accounts`. Never touches `sync_governance`. The two surfaces are independent.

**New schemas**

- `core/notification-config.json` — per-subscriber config. `subscriber_id` always required, `additionalProperties: false`, `ext` for extensions.
- `core/account.notification_configs[]` — read-side echo on the account record.
- `enums/creative-event-reason-code.json` — 13 categorical values distinct from `impairment-reason-code`: `review_passed`, `review_failure`, `processing_failure`, `seller_rereview`, `policy_revocation`, `content_drift`, `takedown_request`, `advertiser_request`, `seller_archive` (folds prior `inactivity_archive` + `storage_policy`), `account_closed`, `account_suspended`, `retention_expired` (soft only), `legal_erasure` (hard only). Each value's enumDescription documents buyer remediation; `policy_revocation` vs `content_drift` carries an explicit "when in doubt" rule.
- `notification-type.json` extended with `creative.status_changed` and `creative.purged`, plus a "media-buy-anchored vs account-anchored" framing for future additions.

**Read surface (#4701 track 4 adoption)**

`list_creatives` adopts the 7-item `webhook_activity[]` checklist:
- `include_purged: true` returns soft-purged tombstones as a wrapped `purge: { kind, at, reason_code }` block — co-presence enforced by schema, not prose. `status` is frozen pre-purge.
- `include_webhook_activity: true` + `webhook_activity_limit` (1–200) return per-creative `webhook_activity[]` records. Items `$ref` the canonical `webhook-activity-record` shape from #4701; `notification_type` discriminates status changes vs purges.

**Pairing with #4588 impairments**

When a creative transition breaks active serving (`approved → rejected`), the seller already MUST surface a corresponding `impairment` on every media buy referencing the creative (per #4588's `impairment.coherence`). The two signals are paired but distinct — buyers correlate by `creative_id`. **No ordering guarantee between the two fires** — explicitly documented; reconcile via the snapshot.

**Retroactive contract**

When a seller declares support via `get_adcp_capabilities`, the obligation covers all creatives in the library — no grace period.

**Docs**

- `docs/accounts/tasks/sync_accounts.mdx` — new § "Two modes: provisioning vs. settings-update" and § "Account-level webhook subscriptions"
- `docs/accounts/tasks/list_accounts.mdx` — `notification_configs` response field documented
- `docs/creative/specification.mdx § Lifecycle webhooks` — state machine + events; supersedes previous SHOULD language; no-ordering note
- `docs/creative/task-reference/list_creatives.mdx` — § Purged tombstones (with `purge` wrapper), § Webhook activity, § Buyer handler (end-to-end example: verify → dedupe → re-read)
- `docs/protocol/snapshot-and-log.mdx` — account-level adopters section + Rule 4 carve-out for hard purges

Closes #2261. Lands #4582 track 3.
