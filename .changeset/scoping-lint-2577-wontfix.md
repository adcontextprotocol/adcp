---
---

Storyboard authoring: document that envelope identity on ID-scoped tasks (`check_governance`, `report_plan_outcome`, `acquire_rights`, `log_event`, `calibrate_content`, `validate_content_delivery`, `validate_property_delivery`) is a sandbox routing convention, not a spec claim.

Production sellers resolve tenant from the authenticated principal (bearer/OAuth/HMAC), not from envelope payload, so there is no spec-level gap to close. The previously-tracked runtime follow-up (cross-session reverse index for ID → session routing) would be sandbox plumbing without spec meaning and is not being pursued.

Docs and lint comments updated; closes the open runtime/cleanup follow-ups from #2577.
