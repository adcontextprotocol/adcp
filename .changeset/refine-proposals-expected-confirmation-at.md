---
"adcontextprotocol": minor
---

Add optional `expected_confirmation_at` (date-time) to the `submitted` response of `refine_proposals` (#8086). A seller whose finalize hold depends on a person's agreement, such as a creator, host or talent, MAY return `submitted` and SHOULD set it so the buyer can schedule a status check instead of polling tightly. It is an estimate, not a commitment, with the same semantics as on `create_media_buy`. Present only on a `submitted` response to a finalize-only request; a `completed` response MUST NOT carry it. Stable optional field (`x-added-in: 3.3.0`); no change for sellers that omit it.
