---
---

Bump `@adcp/client` to `^5.13.0` and close the remaining storyboard
failures that weren't spec-side.

- **5.13 brings** the `governance.denial_blocks_mutation` recovery-path
  fix (adcp-client#813). Closes the last two shared failures:
  `media_buy_seller/governance_denied_recovery` and
  `media_buy_seller/measurement_terms_rejected`.
- **Storyboard CI overlay step** now resolves the cache dir dynamically
  (5.13 moved it from `latest` to the AdCP version string).
- **Cross-session state fallback** (`server/src/training-agent/state.ts`):
  `findSessionMatching` + per-entity wrappers let handlers whose tool
  schemas strip `account` still reach state written by earlier steps
  that kept account context. Wired into `handleCheckGovernance`,
  `handleReportPlanOutcome`, and `handleAcquireRights` (governance
  plan), `handleLogEvent` + `handleProvidePerformanceFeedback` (event
  source / media buy).
- **Sandbox event-source permissiveness**: `handleLogEvent` now
  auto-registers unknown `event_source_id` so storyboards that omit
  `sync_event_sources` (e.g. `sales_social`) still grade ingestion.
- **Envelope emission**: framework `adapt()` wraps successful
  responses with `wrapEnvelope({ replayed: false, context })` so
  idempotency + context-echo fields land on the AdCP envelope per
  spec.

Storyboard lift (overlaid compliance cache):
legacy **44 → 52** clean, framework **38 → 51** clean.

Single residual framework-only failure is
`idempotency/create_media_buy_initial` — the storyboard's
`field_value: replayed [false]` assertion still reads `undefined`
because `create_media_buy` responses go through the framework's
task-capable wrap before `adapt()` runs. Tracked as a separate
follow-up.
