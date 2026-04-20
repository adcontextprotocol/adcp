---
---

Scoping lint: exempt seven tasks whose request schema requires a globally-unique scope-ID (#2577 Option C).

Moving from `TENANT_SCOPED_TASKS` to `EXEMPT_FROM_LINT`:

- `check_governance`, `report_plan_outcome` — required `plan_id`
- `acquire_rights` — required `rights_id`, `buyer`, `campaign`
- `log_event` — required `event_source_id`
- `calibrate_content`, `validate_content_delivery` — required `standards_id`
- `validate_property_delivery` — required `list_id` (schema also has optional `account`)

These tasks resolve the tenant from the ID alone; envelope `account` is redundant at the spec level. Storyboards may still carry identity for training-agent session routing — the lint simply doesn't require it. Authoring guide (`docs/contributing/storyboard-authoring.md`) documents the split.

Spec-level follow-ups (runtime routes by ID, schema additions for the no-scope-ID tasks that stayed in `TENANT_SCOPED_TASKS`) remain tracked in #2577.
