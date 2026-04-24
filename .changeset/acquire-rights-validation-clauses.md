---
"adcontextprotocol": patch
---

docs(brand): specify normative request-validation clauses for `acquire_rights` (closes #2680, #2681)

Two campaign-field validations on `acquire_rights` were sensible-but-unspecified in 3.0, leaving implementers to disagree on identical requests:

1. **Expired campaign window.** Brand agents MUST reject with `INVALID_REQUEST` and `field: "campaign.end_date"` when `campaign.end_date` is in the past at the time of the request. Issuing a zero-duration grant is almost always a buyer-side bug; deterministic rejection is more useful than silent expiry. Unlike `create_media_buy` (where `any_of` supports time-shifting a flight forward), rights grants attach to the requested period and cannot be retroactively shifted, so reject-only is the correct contract.

2. **CPM-priced rights under a governed plan.** When the request carries an intent-phase `governance_context` token (the buyer's plan is governed) and the selected pricing option has `model: "cpm"`, brand agents MUST reject with `INVALID_REQUEST` and `field: "campaign.estimated_impressions"` when that field is omitted or `0`. When provided, projected commitment is `(pricing_option.price / 1000) × campaign.estimated_impressions` evaluated in `pricing_option.currency`. If `pricing_option.currency` differs from the plan's budget currency, the agent MUST reject with `field: "pricing_option_id"` — currency conversion is not specified. If the projected commitment exceeds remaining plan budget, the agent MUST reject with `field: "campaign.estimated_impressions"`. Non-CPM pricing options commit the flat amount regardless of volume; agents MUST NOT require `estimated_impressions` for governance projection on those.

Added a new "Request validation" section to `docs/brand-protocol/tasks/acquire_rights.mdx` and tightened the field descriptions on `static/schemas/source/brand/acquire-rights-request.json` for `campaign.end_date` and `campaign.estimated_impressions` so the validation contract is discoverable from both the task reference and the schema.

Patch-eligible: docs-only clarification of behavior the spec already implied. No schema shape changes (only description text); no new error codes (`INVALID_REQUEST` is already standard). The `governance_context` anchor and the `(price / 1000) × impressions` projection formula reference fields that exist on the published 3.0 schemas — this PR does not introduce new wire surface, only normative interpretation.
