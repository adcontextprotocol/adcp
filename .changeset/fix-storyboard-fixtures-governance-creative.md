---
---

Fix storyboard fixtures that fail validation against the 3.0 GA JSON Schemas. Surfaced by the `@adcp/client` skill-matrix harness.

**`check_governance` fixtures** — `check-governance-request.json` has `required: ["plan_id", "caller"]` and `additionalProperties: false` at the root, with intent checks using `tool` + `payload` (where `payload` is the full tool arguments). Fixtures had top-level `account`/`binding`/`human_approval`, were missing `caller`, and their `payload` did not validate as a `create_media_buy` request (scalar `total_budget` instead of proposal-mode money object, missing `idempotency_key`/`brand`/`start_time`/`end_time`, missing `packages[].pricing_option_id`). Fixed in:

- `static/compliance/source/protocols/governance/index.yaml` — `check_governance_denied` and `check_governance_approved` steps. Approved-step `human_approval` removed; per schema, human approval is carried in the `governance_context` JWS. Closes #2740.
- `static/compliance/source/specialisms/governance-spend-authority/denied.yaml` — `check_governance_denied` parallel fixture (same bug).

**`build_creative` fixture** — `build-creative-request.json` has no `output_format` field and requires `idempotency_key`. `target_format_id` is the single-format field. Fixed in:

- `static/compliance/source/protocols/creative/index.yaml` — `build_video_tag` step: renamed `output_format` → `target_format_id`, added `idempotency_key`. Closes #2741.

Three other `check_governance` fixtures in `specialisms/governance-spend-authority/index.yaml`, `specialisms/governance-delivery-monitor/index.yaml` have the same drift and will be addressed in a follow-up issue.
