---
"adcontextprotocol": minor
---

spec(media-buy): billing authority + finality flags on both reporting surfaces (closes #2391 for 3.1; dispute task deferred to 3.2).

Closes part 1 of #2391 — the prerequisite to a structured dispute task. A buyer reading the 3.1 spec can now answer "where do I look for the billing-grade number, and has it stopped moving?" without any new tasks: existing `measurement_terms.billing_measurement` already names the authoritative party; new finality flags on both reporting surfaces mark when numbers are closed for invoicing.

Changes:

- `static/schemas/source/media-buy/get-media-buy-delivery-response.json` — add row-level `is_final` and `finalized_at` on `media_buy_deliveries[*]` (alongside existing per-package `is_final`); add `finalized_at` on each `by_package[*]` entry next to existing `is_final`. Row-level finality is equivalent to all packages being final for the same `measurement_window`.
- `static/schemas/source/account/report-usage-request.json` — add `final` (default true on absence), `finalized_at` (present iff `final: true`), and `measurement_window` to each usage record. Symmetric with seller-side delivery rows. Description updated to acknowledge sales-agent receivers for buyer-attested / vendor-attested reconciliation.
- `static/schemas/source/core/measurement-terms.json` — add optional `finalization_deadline_hours` on `billing_measurement`. When the authoritative party misses the deadline, the seller MAY fall back to seller-attested numbers and the breach is handled under `makegood_policy`.
- `docs/media-buy/task-reference/get_media_buy_delivery.mdx` — replace the "AdCP 3.0 does not specify a structured dispute task" paragraph with normative "Final vs provisional" + "Who is authoritative for billing" sections; point at the new advanced-topics page; flag dispute task for 3.2.
- `docs/media-buy/advanced-topics/billing-authority.mdx` — new normative page tying the pieces together with worked examples (seller-attested, buyer-3PAS, vendor-attested Nielsen).
- `docs.json` — register the new page under media-buy → Concepts.

Strictly additive — no existing fields change shape, no required-field additions. Agents that don't emit `is_final`/`final`/`finalized_at` remain spec-valid; the absent semantics match the 3.0 baseline.

A 3.2 issue tracks the structured dispute task that builds on this foundation.
