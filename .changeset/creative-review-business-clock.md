---
"adcontextprotocol": minor
---

Keep `core/sla-window.json` and the buy action rows at their 3.2.8 shape: business time and the creative review SLA stay on the product (adcp#8501, entries 4, 5, 11 and 12). `sla-window`, `media-buy-available-action` and `canonical-media-buy-action-fields` are closed. 3.3.0-beta.1 added `clock` and `business_calendar_id` to the first and `review_sla` to the other two, so a strict 3.2 validator rejected them, and a minor release never changes a closed schema (DR-0036).

**`clock` and `business_calendar_id` now live on `core/creative-review-sla.json` (entries 11 and 12).** `creative_policy.review_sla` keeps business time: `clock` defaults to `elapsed`, `clock: "business"` requires a `business_calendar_id` that resolves to `get_adcp_capabilities.business_calendars[]`, and the calendar and snapshot rules are unchanged. The schema no longer composes `sla-window`. It defines `response_max` and `completion_max` itself, keeps `completion_max` required, and is open, the default for a new 3.3 schema.

**Every other SLA is elapsed time, as in 3.2.** The signed terms use `sla-window` through `change_terms[].processing_sla`, and 3.2.8 says sellers include weekends and non-working periods in the maximum. An action's `sla` on `allowed_actions[]` and `available_actions[]`, a change term's `processing_sla`, and `core/escalation-sla.json` reject `clock` and `business_calendar_id`. `escalation-sla` loses the `clock: "elapsed"` it accepted in the betas.

**`review_sla` leaves the buy's actions (entries 4 and 5).** `core/media-buy-available-action.json` and `core/canonical-media-buy-action-fields.json` no longer carry `review_sla` or the rule tying it to creative actions. The product's `creative_policy.review_sla` already carries the commitment, and a buy doesn't change it. `get_media_buys` accepts either row, so both go together. Buyers read the commitment from the package's product.

**This changes 3.3.0-beta.1 through beta.4.** The betas are immutable. A seller or SDK built from one sends `clock` and `business_calendar_id` only on `creative_policy.review_sla`, and stops sending `review_sla` on `available_actions[]` entries. The 3.3 release notes, What's new, the 3.2 to 3.3 migration guide, and the service commitments and `sync_creatives` pages are updated.
