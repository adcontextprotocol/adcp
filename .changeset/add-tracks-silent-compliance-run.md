---
"adcontextprotocol": minor
---

feat(registry): add optional `tracks_silent` to `ComplianceRun` schema

Adds an optional `tracks_silent: integer` field to `ComplianceRun` in
`openapi/registry.yaml`, alongside the existing `tracks_passed`,
`tracks_failed`, `tracks_skipped`, and `tracks_partial` fields.

`tracks_silent` counts tracks where every observation-based invariant ran
but received no lifecycle resource events during the run — configured but
not exercised. Counting these separately from `tracks_passed` lets
dashboards avoid over-crediting silent tracks as real protection.

The field is **optional** (not in `required:`) for back-compat with runs
persisted before SDK 6.4.0 (`adcp-client#1163`), which widened
`TrackStatus` with `'silent'` and started emitting `tracks_silent` in
`ComplianceSummary`. Without this schema addition, downstream services
deserialize pre-existing runs with `tracks_silent: undefined` and cannot
render silent rows distinctly.

Non-breaking: adds an optional field; existing consumers unaffected.

Closes #3752.
