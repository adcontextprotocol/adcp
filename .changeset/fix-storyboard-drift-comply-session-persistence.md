---
---

Fix pre-3.0 `sync_plans` sample_requests in governance storyboards (#2266). Updates `campaign_governance` / `governance_spend_authority` / `governance_delivery_monitor` bundles plus the `governance_approved` / `governance_conditions` / `governance_denied` / `governance_denied_recovery` scenarios to use the current `plan_id` / `objectives` / `budget` / `flight` shape with a top-level `idempotency_key`. Reshapes `custom_policies` entries to the `policy-entry` schema.

Fix training-agent `comply_test_controller` state loss across requests (#2274). Moved account / SI-session / delivery / budget simulation state into `SessionState.complyExtensions` so it survives the per-request serialize/deserialize round trip — previously held in a `WeakMap<SessionState, ...>` that became empty on every rehydration.

Fix the `structuredContent`-only branch of the MCP response unwrap test to read `adcp_error.code` (what `unwrapProtocolResponse` actually returns) instead of a non-existent `errors[0].code`.

Fix two `storyboards.test.ts` iteration tests that timed out at 5s by switching the inner lookups from O(N²) `getStoryboard(id)` scans to a single `getAllStoryboards()` pass.

Add `npm run test:server-unit` to `build-check.yml` so server unit regressions fail at PR time.
