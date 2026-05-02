---
---

Fix skill/storyboard contradiction in sales_guaranteed: add non-guaranteed fixture products
and clarify that requires_io_approval is scoped to delivery_type: guaranteed creates only.
The four shared seller scenarios (measurement_terms_rejected, pending_creatives_to_start,
inventory_list_targeting, invalid_transitions) require synchronous creates against
non-guaranteed products; without these fixtures a blind agent following the seller skill
fails all four. Closes #3822.
