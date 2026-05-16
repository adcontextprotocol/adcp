---
---

feat(compliance): unified anti-façade and cascade-attribution contract (#3813)

Closes #3785, #3796 with a single coherent contract change. Storyboard adoption of the new `upstream_traffic` check follows in a paired runner update — the published @adcp/sdk runner errors hard on unrecognized check types today, so storyboard adoption is blocked until the runner ships forward-compat handling and the new check implementation.

**runner-output-contract.yaml v1.1.0 → v2.0.0**
- Adds three codes to `validation_result.check`:
  - `capture_path_not_resolvable` (synthesized) — emitted on the capturing step when a `context_outputs` path resolves to absent / `null` / `""`. Replaces the silent-skip cascade described in #3796.
  - `unresolved_substitution` (synthesized) — emitted on a consumer step when `$context.<name>` or `{{prior_step.<id>.<field>}}` cannot resolve. Pre-wire null carve-outs on `request` / `response` / `json_pointer`.
  - `upstream_traffic` (authored) — asserts a storyboard step caused observable upstream traffic carrying the supplied identifiers, queried via `comply_test_controller`'s new `query_upstream_traffic` scenario. The load-bearing anti-façade contract from #3785 item 3.
- **Forward-compat clause:** runners MUST grade unrecognized authored `check` values as `not_applicable` (with a `note` field describing the coverage gap), not failed. Additive check-type extensions are part of the spec evolution model. Adds `validations_not_applicable` to `run_summary` so consumers can distinguish "runner is older than the storyboard" from clean passes.
- Documents `expected` / `actual` / `json_pointer` semantics per code.
- `run_summary` accounting notes — capture failures contribute to `steps_failed`, downstream skips to `steps_skipped` with `prerequisite_failed`. `upstream_traffic` against an adopter that doesn't advertise the scenario grades `not_applicable`, not failed.

**storyboard-schema.yaml**
- Adds `upstream_traffic` check kind with full semantics block (`min_count`, `endpoint_pattern`, `payload_must_contain`, `buyer_identifier_echo` shorthand, `since: prior_step_id` window).
- Strengthens `context_outputs` runner-behavior note to cover the three non-resolvable cases.
- Expands `capture_path_not_resolvable` and `unresolved_substitution` grading-code descriptions with output-shape cross-references.

**comply-test-controller-request.json / comply-test-controller-response.json**
- Adds `query_upstream_traffic` scenario to the request enum, with optional `since_timestamp`, `endpoint_pattern`, and `limit` params.
- Adds `UpstreamTrafficSuccess` branch to the response `oneOf`: `recorded_calls[]` with `method` / `endpoint` / `url` / `host` / `path` / `payload` / `timestamp` / `status_code`, plus `total_count` / `truncated` / `since_timestamp`.
- Reuses the existing test-controller mechanism rather than introducing a separate `/_debug/traffic` URL.

**One storyboard bug fix**
- `sales-social`: `value` / `currency` in `log_event.events[]` moved into `custom_data` per `event-custom-data.json`. The parent's `additionalProperties: true` was silently swallowing the fields at the wrong nesting level, meaning real upstreams never saw the purchase value. Independent of the anti-façade work.

**Sibling-repo runner work needed (adcp-client / @adcp/sdk):**
1. Implement forward-compat default in `validations.js` per the new spec — grade unrecognized check kinds as `not_applicable`, not failed.
2. Implement `capture_path_not_resolvable` / `unresolved_substitution` emission per the contract.
3. Implement `upstream_traffic` check: query `comply_test_controller` with `query_upstream_traffic`, scoped to the step's request timestamp (or the `since: <step_id>` declaration), apply `min_count` / `endpoint_pattern` / `payload_must_contain` / `buyer_identifier_echo` assertions.

Once that ships and a new @adcp/sdk publishes, a follow-up adcp PR adopts `upstream_traffic` across applicable storyboards (sales-social, audience-sync, signal-marketplace, sales-non-guaranteed, creative-ad-server, plus the rest of the suite where applicable).
