---
---

Bump `@adcp/client` to `^5.12.0`. Closes most of the framework-mode
storyboard zod-parity gap by picking up the SDK's spec-shaped
request-builders for `log_event`, `create_media_buy`,
`list_creative_formats`, `si_*`, and `sync_governance`
(adcp-client#794, #789, #802). Also pulls in the VALIDATION_ERROR
retry-storm fix (adcp-client#758).

CI baselines drop on both modes because the runner now emits every
authored package on `create_media_buy` (adcp-client#794), which exposes
that several storyboards reference per-package products our catalog
does not seed (`outdoor_video_q2`, `late_fringe_15s_mf`,
`outdoor_ctv_q2_guaranteed`, `lifestyle_display_q2`). Wiring those
through the new `controller_seeding: true` + `fixtures:` SDK feature
(adcp-client#790) is tracked as a separate task.

Framework-only delta vs. legacy is now 5 storyboards / 7 step failures:
`acquire_rights_denied` error code, `calibrate_content` verdict,
`log_event` / `provide_feedback` session lookups, `report_usage`
`accepted` field type. Residual zod-parity follow-up.
