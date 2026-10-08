---
"adcontextprotocol": minor
---

spec(reporting): receivers MUST ignore `aggregated_totals` if present in a delivery webhook result and MUST NOT treat it as authoritative. The sender-side MUST NOT is unchanged. The `media-buy-delivery-webhook-result.json` description now says the field is API-only, and `webhooks.mdx` and `versioning.mdx` state that a prose MUST NOT on a field absent from an open schema (DR-0009) is normative and graded through storyboards. No schema property is added and no `not` guard is introduced, so published validation is unchanged.
