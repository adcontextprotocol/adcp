---
---

Training agent: three more storyboard fixes while we chase full 3.0
compliance, plus filed 6 upstream spec-clarification issues.

- **`comply_test_controller` sandbox gate narrowed**: was rejecting
  every call without `account.sandbox: true`, which blocked the
  `deterministic_testing` storyboard from probing error codes
  (UNKNOWN_SCENARIO, INVALID_PARAMS, NOT_FOUND). Training agent is
  sandbox-only by deployment; only reject when `account.sandbox:
  false` is explicitly set. +4 `deterministic_testing` steps closed
  (now 25/26 passing, the 1 remainder is a schema-validation edge).
- **`cpm_guaranteed` pricing alias on `sports_ctv_q2`**: `governance_spend_authority`
  storyboard hardcodes this pricing option id. Add to the aliased
  pricing list so create_media_buy resolves.
- **`TERMS_REJECTED` on unworkable measurement_terms**: reject
  `max_variance_percent < 0.5%` and `measurement_window: "c30"` —
  matches the storyboard's aggressive-terms probe. (Note: not yet
  firing end-to-end — under investigation whether the SDK client is
  stripping the `measurement_terms` field before it reaches the
  handler; see adcp#2605.)

Plus upstream: filed 6 spec-clarification issues (adcp#2603–#2608)
covering any_of branches tested as single-branch, underspec'd
conditional-approval, storyboard assertions against schema-optional
fields, idempotency missing-key SDK coupling, PRM for non-OAuth
agents, and implementer DX docs (troubleshooting + known-ambiguities).

37/55 clean, 288 steps passing (was 37/55, 282).
