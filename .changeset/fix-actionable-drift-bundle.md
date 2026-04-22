---
---

Bundle resolution of all remaining actionable storyboard sample_request drift (adcp#2763 cluster follow-ups to #2768, #2781, #2788). 16 fixtures patched; allowlist shrinks 29 → 13.

Changes by theme:
- **Negative-test detection** broadens to treat `expect_error: true` as a negative-step marker alongside the existing `error_code` / `http_status_in` heuristics. This is the canonical marker throughout the suite and closes two entries (`reversed_dates`, `missing_fields`) without requiring per-fixture opt-ins.
- **Shape completion** for fixtures missing fields the schema requires: `account`, `reason`, `query`/`uses`, `external_id`, `event_time`, `event_source_id`, `package_id`, `total_budget: {amount, currency}` (2 fixtures), `request_type`/`creative_manifest`/`assets`/`format_id`, `creatives[]` padding for reference-only sync_creatives.
- **Additional-property removal** on `accounts[].brand.name` where the schema rejects it.
- **Capture-site updates** for `sales-non-guaranteed` to expose `first_package_id`/`second_package_id` from create_media_buy so the update_media_buy step can reference them by package_id per schema.
- **Negative-test opt-in** on `universal/error-compliance.yaml#missing_fields` via `sample_request_skip_schema: true` — the step intentionally tests the "missing buying_mode" path and doesn't carry an `expect_error` marker (the step accepts either a response or an error as valid).

The remaining 13 allowlist entries are blocked on WG decisions in upstream issues adcp#2774-#2776 (refine[] naming, SI `context` field collision, governance `account` rejection) plus the dedicated `sales-social/sync_dpa_creative` cluster being handled in a separate PR.
