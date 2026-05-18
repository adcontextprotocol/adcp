---
"adcontextprotocol": patch
---

Storyboard: mark `deterministic_session`, `deterministic_delivery`, `deterministic_budget` as `depends_on: []`

These three phases of the `deterministic_testing` storyboard each create their own state (their own session and their own media buys via in-phase steps). They don't consume context from each other or from earlier deterministic_* phases.

The runner's `phase.depends_on` default ("depend on all prior phases") was over-cascading: when a seller without `si_initiate_session` correctly skipped `deterministic_session/initiate_session` with `missing_tool`, the cascade tripped and `deterministic_delivery` + `deterministic_budget` were also skipped, even though they only need `create_media_buy` + `comply_test_controller`.

Explicit `depends_on: []` removes the false dependency. Non-SI sellers that implement the controller can now be graded on delivery and budget simulation independently.

Reported in adcp-client#1711 follow-up.
