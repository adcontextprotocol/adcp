---
---

Wire 3.0 primitive scenarios into sales-* specialism `requires_scenarios`.

The `media_buy_seller/{measurement_terms_rejected, governance_denied_recovery,
pending_creatives_to_start, inventory_list_targeting, inventory_list_no_match,
invalid_transitions}` scenarios existed but were not referenced by the
specialism files a storyboard runner inspects to grade a claim. This surfaces
them on `sales-guaranteed`, `sales-non-guaranteed`, `sales-broadcast-tv`,
`sales-catalog-driven`, and `sales-proposal-mode` with the subset appropriate
for each specialism (e.g., `measurement_terms_rejected` only where measurement
terms are negotiable; `inventory_list_*` only where property/collection list
targeting applies).

Addresses adcontextprotocol/adcp#2228.
