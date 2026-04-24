---
---

Add explicit seller implementation guidance: media buy `status` must be stored as a persisted database field and updated only via protocol events — not recomputed from flight-date arithmetic. Date logic cannot produce `paused`, `canceled`, or `rejected`; recomputing silently suppresses those states and breaks `valid_actions`.

Added a normative note to `docs/media-buy/media-buys/index.mdx` (lifecycle states section) and a brief cross-referencing callout in `docs/building/implementation/seller-integration.mdx`.

Closes #3028
