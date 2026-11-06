---
"adcontextprotocol": minor
---

Keep `core/sla-window.json` at its 3.2.8 shape and move business time onto the creative review SLA (adcp#8501, entries 11 and 12). `sla-window` is closed, and 3.3.0-beta.1 added `clock` and `business_calendar_id` to it, so a strict 3.2 validator rejected a 3.3 SLA and a minor release never changes a closed schema (DR-0036). The signed terms use `sla-window` through `change_terms[].processing_sla`, and 3.2.8 says sellers include weekends and non-working periods in the maximum, so the signed SLA stays elapsed time.

**`clock` and `business_calendar_id` now live on `core/creative-review-sla.json`.** `creative_policy.review_sla` keeps business time: `clock` defaults to `elapsed`, `clock: "business"` requires a `business_calendar_id` that resolves to `get_adcp_capabilities.business_calendars[]`, and the calendar and snapshot rules are unchanged. The schema no longer composes `sla-window`. It defines `response_max` and `completion_max` itself, keeps `completion_max` required, and is open, the default for a new 3.3 schema.

**Every other SLA is elapsed time, as in 3.2.** An action's `sla` on `allowed_actions[]` and `available_actions[]`, a change term's `processing_sla`, and `core/escalation-sla.json` reject `clock` and `business_calendar_id`. `escalation-sla` loses the `clock: "elapsed"` it accepted in the betas.

**This changes 3.3.0-beta.1 through beta.4.** The betas are immutable. A seller or SDK built from one stops sending `clock` and `business_calendar_id` anywhere except `creative_policy.review_sla` and the `review_sla` on a creative action. The 3.3 release notes, What's new, the 3.2 to 3.3 migration guide, and the service commitments page are updated.
