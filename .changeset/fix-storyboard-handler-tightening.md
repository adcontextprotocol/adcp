---
---

Tighten storyboard handlers across both legacy and framework dispatch
to close five shared step failures. Lift (against overlaid compliance
cache): legacy 44 → 50 clean, framework 38 → 44 clean.

Handler changes (`server/src/training-agent/`):

- `comply_test_controller.forceCreativeStatus` allows the
  `approved → rejected` transition so `force_creative_rejected` can
  test post-approval brand-safety rejection flows.
- `handleListCreatives` always emits `name` and
  `format_id.agent_url`, falling back to `creative_id` and the agent's
  own URL when absent. Keeps response-schema validation green when a
  sync_creatives payload omits either.
- `handleCalibrateContent` scans the artifact text for must-rule
  keywords (violent, gambling, alcohol, stock photo, missing alt
  text) and returns `verdict: fail` when a match hits. Prior behavior
  returned pass unconditionally.
- `handleLogEvent` / `handleProvidePerformanceFeedback` fall back to a
  global scan when the request-level session key misses. The SDK
  strips `account` against each tool's published schema, so these
  tools land on `open:default` while `sync_event_sources` /
  `create_media_buy` wrote under `open:<brand.domain>`.

Spec-side tightening (`static/compliance/source/`):

- `protocols/brand/index.yaml` drops two validation checks the SDK
  doesn't implement (`array_contains`, `is_error`) in favor of
  `field_present` + `error_code` with allowed values.
- `specialisms/brand-rights/index.yaml` captures
  `rights.0.pricing_options.0.pricing_option_id` as
  `$context.pricing_option_id` and references it in `acquire_rights`,
  replacing the hard-coded `standard_monthly` (no agent offering
  exposed that id).
