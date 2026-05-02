---
---

feat(compliance): unified anti-façade and cascade-attribution landing (#3813)

Closes #3785, #3796 with a single coherent contract change instead of two partial-ship spec PRs and a runner-side workaround.

**runner-output-contract.yaml v1.1.0 → v2.0.0**
- Adds three codes to `validation_result.check`:
  - `capture_path_not_resolvable` (synthesized) — emitted on the capturing step when a `context_outputs` path resolves to absent / `null` / `""`. Replaces the silent-skip cascade described in #3796.
  - `unresolved_substitution` (synthesized) — emitted on a consumer step when `$context.<name>` or `{{prior_step.<id>.<field>}}` cannot resolve. Pre-wire null carve-outs on `request` / `response` / `json_pointer`.
  - `upstream_traffic` (authored) — asserts a storyboard step caused observable upstream traffic carrying the supplied identifiers, queried via `comply_test_controller`'s new `query_upstream_traffic` scenario. The load-bearing anti-façade contract from #3785 item 3.
- Documents `expected` / `actual` / `json_pointer` semantics per code.
- Adds `run_summary` accounting notes — capture failures contribute to `steps_failed`, downstream skips to `steps_skipped` with `prerequisite_failed`. `upstream_traffic` against an adopter that doesn't advertise the scenario grades `not_applicable`, not failed.

**storyboard-schema.yaml**
- Adds `upstream_traffic` check kind with full semantics block (`min_count`, `endpoint_pattern`, `payload_must_contain`, `buyer_identifier_echo` shorthand, `since: prior_step_id` window).
- Strengthens `context_outputs` runner-behavior note to cover the three non-resolvable cases.
- Expands `capture_path_not_resolvable` and `unresolved_substitution` grading-code descriptions with output-shape cross-references.

**comply-test-controller-request.json / comply-test-controller-response.json**
- Adds `query_upstream_traffic` scenario to the request enum, with optional `since_timestamp`, `endpoint_pattern`, and `limit` params.
- Adds `UpstreamTrafficSuccess` branch to the response `oneOf`: `recorded_calls[]` with `method` / `endpoint` / `url` / `host` / `path` / `payload` / `timestamp` / `status_code`, plus `total_count` / `truncated` / `since_timestamp`.
- Reuses the existing test-controller mechanism rather than introducing a separate `/_debug/traffic` URL — same auth, same sandbox-only gating, same `list_scenarios` discovery.

**Storyboard adoption (5 exemplars)**
- `sales-social`: realistic `add[]` on `sync_audiences` and `user_match` on `log_event`; `value`/`currency` moved into `custom_data` (schema-routing fix); `upstream_traffic` assertions on both steps with `buyer_identifier_echo`.
- `audience-sync`: `upstream_traffic` on `create_audience` with `buyer_identifier_echo` and `payload_must_contain` for `hashed_email`.
- `signal-marketplace`: `upstream_traffic` on `activate_on_platform` with `since: search_by_spec` window and `payload_must_contain` for `segment_id`.
- `sales-non-guaranteed`: `upstream_traffic` on `create_media_buy` (platform-agnostic POST count assertion).
- `creative-ad-server`: `upstream_traffic` on `build_creative` (platform-agnostic POST count assertion).

Mechanical rollout to the remaining 7 applicable specialisms (sales-guaranteed, sales-broadcast-tv, sales-catalog-driven, sales-proposal-mode, signal-owned, creative-template, creative-generative) follows in a separate PR — the contract is fully defined and adoption is mechanical, not theatrical.

**Sibling-repo runner work needed (adcp-client):**
- Implement `capture_path_not_resolvable` / `unresolved_substitution` emission per the contract.
- Implement `upstream_traffic` check: query `comply_test_controller` with `query_upstream_traffic`, scoped to the step's request timestamp (or the `since: <step_id>` declaration), apply `min_count` / `endpoint_pattern` / `payload_must_contain` / `buyer_identifier_echo` assertions.
- Adopters who don't advertise `query_upstream_traffic` in `list_scenarios` grade `upstream_traffic` checks as `not_applicable` — opt-in by capability.
