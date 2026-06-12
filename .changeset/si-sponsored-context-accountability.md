---
"adcontextprotocol": minor
---

Add Sponsored Intelligence sponsored-context accountability primitives.

New SI schemas define `context_use` (`presentation_only`, `comparison_set`, `reasoning_context`), `sponsored_context` declarations, and host `sponsored_context_receipt` records. `si_get_offering`, `si_initiate_session`, and `si_send_message` now have optional fields for carrying those declarations and receipts across the host boundary.

The model separates `paying_principal` (who economically sponsored the context) from `host_receipt` (what use mode and disclosure commitment the receiving host accepted). Accepted receipts must include the accepted use mode and disclosure commitment; hosts that cannot honor the declaration reject the context rather than down-scoping it.
