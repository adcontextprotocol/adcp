---
"adcontextprotocol": patch
---

Storyboard: mark all six independent `deterministic_*` phases as `depends_on: []`, and document `Phase.depends_on` in the storyboard schema

All six phases of the `deterministic_testing` storyboard — `deterministic_account`, `deterministic_media_buy`, `deterministic_creative`, `deterministic_session`, `deterministic_delivery`, `deterministic_budget` — each create their own state in-phase (their own account, media buy, creative, or session via `comply_test_controller`-gated steps) and consume no `$context.*` value produced by an earlier phase. They were exposed to the runner's default cross-phase cascade ("phase depends on all prior phases"), which over-cascaded: when a seller without `si_initiate_session` correctly skipped `deterministic_session/initiate_session` with `missing_tool`, the cascade also tripped `deterministic_delivery` and `deterministic_budget`. The same risk existed for the other three phases on any adopter that legitimately skips an earlier deterministic phase. Explicit `depends_on: []` removes the false dependency in all six.

Also documents `Phase.depends_on` in `storyboard-schema.yaml` — the field was supported by the runner (introduced in adcp-client#1161) but undocumented in the spec-side schema, which is why this trap kept catching storyboard authors.

Reported in adcp-client#1711 follow-up.
