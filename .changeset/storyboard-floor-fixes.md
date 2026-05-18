---
"adcontextprotocol": patch
---

fix(training-agent + compliance): re-baseline storyboard floors after fixing four pre-existing failures on main.

Main was running at the exact 69-clean floor for `/sales` with 4 storyboards real-failing — any flake on `media_buy_seller/audience_buy_flow`'s phantom-rejection step dropped it below floor. Four bugs, each independent:

- **`/sales/mcp` (v6 framework) was missing `syncEventSources` and `logEvent`** in `TrainingSalesPlatform`. The SDK framework only advertises platform methods that exist, so `sync_event_sources` / `log_event` steps in `event_dedup_flow` and `performance_buy_flow` were silently skipped — leaving subsequent `create_media_buy` steps with optimization_goals referencing event_sources rejected as "not registered". Wired both methods through to the v5 handlers with brand_domain threaded from `ctx.account.ctx_metadata` (same pattern as `syncAudiences`).
- **Phantom-rejection steps in `audience_buy_flow` and `performance_buy_flow` were missing `expect_error: true`.** Both steps submit a `create_media_buy` with an intentionally-unregistered id and assert the rejection's error.field; the SDK runner needs the marker to invert pass/fail. Added `expect_error: true` + `negative_path: payload_well_formed`, matching `invalid_transitions`.
- **`proposal_finalize_asap_timing` rejected with `IO_REQUIRED`.** The scenario narrative claimed `io_acceptance` was "intentionally omitted because requires_signature is false on this proposal" — but the training agent's seeded proposal carries `requires_signature: true`. The scenario's discriminating assertion is `start_time: "asap"`, not the IO gate; including `io_acceptance` keeps the IO gate satisfied so the start-timing form is what's tested. Added `context_outputs` for `io_id` extraction and included `io_acceptance` on the create step.

After fixes, `/sales` lifts from 69→73 clean (350 passing). Other tenants also lifted from the SDK roll-up and earlier work; floors bumped with 1-clean buffer for flake tolerance:

| Tenant | Old floor | New floor | Observed |
|---|---|---|---|
| signals | 70:111 | 74:111 | 75 |
| sales | 69:315 | 72:340 | 73 |
| governance | 69:151 | 73:151 | 74 |
| creative | 69:169 | 73:169 | 74 |
| creative-builder | 66:146 | 70:146 | 71 |
| brand | 69:96 | 73:96 | 74 |

Known failing storyboards that did not lift cleanly and are left for follow-up:
- `media_buy_seller/dependency_impairment` + `dependency_impairment_cardinality` (#4685/#4677): need full impairment-tracking in the TA — creative-status transitions don't currently propagate to `media_buy.impairments[]`, and `update_media_buy` swap-assignment doesn't clear stale entries. Feature work, not a fix.
- `signed_requests-strict-required` / `signed_requests-strict-forbidden`: vectors signed without (or with) content-digest can't pass a verifier mode that requires (or forbids) it. The SDK grader's `covers_content_digest: 'either'` permissiveness rule doesn't account for the structural incompatibility. Needs SDK-side fix or expanded `skipVectors` list.

Files:
- `server/src/training-agent/v6-sales-platform.ts` — `syncEventSources` + `logEvent` wired into `TrainingSalesPlatform.sales`.
- `static/compliance/source/protocols/media-buy/scenarios/audience_buy_flow.yaml` — `expect_error: true` on phantom-audience step.
- `static/compliance/source/protocols/media-buy/scenarios/performance_buy_flow.yaml` — `expect_error: true` on phantom-source step.
- `static/compliance/source/protocols/media-buy/scenarios/proposal_finalize_asap_timing.yaml` — `io_acceptance` on the asap create step + `io_id` context output on finalize.
- `.github/workflows/training-agent-storyboards.yml`, `scripts/run-storyboards-matrix.sh` — floors lifted.
