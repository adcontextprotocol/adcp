---
---

creative-ad-server storyboard: pricing and billing are now modeled as optional,
matching the spec schema. The specialism no longer fails ad servers that bill
out of band (flat license, SaaS contract, bundled enterprise — CM360-shaped
agents).

Changes in creative-ad-server/index.yaml:
- Removed hard `field_present` assertions on `creatives[0].pricing_options` and
  nested `pricing_option_id` from the list_creatives step. `response_schema`
  already validates shape when pricing is present (vendor-pricing-option.json
  requires pricing_option_id + a valid pricing model + ISO-4217 currency, so
  malformed pricing is still caught when any is returned).
- Removed hard `field_present` on `pricing_option_id` from the build_creative
  step for the same reason.
- Softened the report_billing assertion: removed the `accepted == 1` requirement.
  Agents that bill through AdCP still return accepted: 1 with empty errors;
  agents that bill out of band return accepted: 0 with an errors entry pointing
  at the offending record and a message explaining that billing is handled out
  of band. Both shapes pass response_schema. Narrative explicitly discourages
  fake-acceptance — silent drops break buyer-side reconciliation.
- Updated narratives and `expected` fields throughout the storyboard to call
  out the conditional nature of pricing/billing — authors won't re-introduce
  the hard assertions on the next edit.
- Updated summary and top-level narrative to reflect "optionally bills through
  AdCP" rather than "with pricing and billing."

Also documents the signal-specialism asymmetry:
- signal-marketplace/index.yaml and signal-owned/index.yaml narratives now
  explain why pricing stays hard-required there (signals are rate-carded goods
  by definition; a signal agent without pricing is non-commercial and belongs
  on a different surface). Preempts "why not signals?" questions from
  implementers comparing specialisms.

Audited the rest of the specialisms and protocols for similar over-assertions
on business-model-dependent fields (pricing, measurement, DCO, concept
grouping). No other cases found — `field_present` assertions on pricing fields
were localized to creative-ad-server and the signal specialisms (where the
assertion is correct).
