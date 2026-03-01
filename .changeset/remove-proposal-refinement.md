---
"adcontextprotocol": major
---

Redesign `refine` as a typed change-request array with seller acknowledgment

The `refine` field is now an array of change requests, each with a `scope` discriminator (`request`, `product`, or `proposal`) and an `ask` field describing what the buyer wants. The seller responds via `refinement_applied` — a positionally-matched array reporting whether each ask was `applied`, `partial`, or `unable`. This replaces the previous object structure with separate `overall`, `products`, and `proposals` fields.
