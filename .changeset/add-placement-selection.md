---
"adcontextprotocol": minor
---

Unify package targeting intent and applied readback. Placement selection now lives inside `targeting_overlay`, properties/placements/collections resolve jointly through `targeting_resolution.inventory`, demographic execution moves under `targeting_resolution.demographics`, and all targeting axes share a complete applied overlay with exact-equivalence semantics. Adds the `update_placements` lifecycle action and `PLACEMENT_SELECTION_INVALID` recovery contract.
