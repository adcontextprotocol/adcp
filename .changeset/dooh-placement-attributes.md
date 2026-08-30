---
"adcontextprotocol": minor
---

Add DOOH structured selling-unit fields to placements: `dooh_placement_attributes` (slot_duration_seconds, loop_duration_seconds, screen_resolution, motion) and `identifiers[]` on both placement.json and placement-definition.json. Define deterministic publisher/product inheritance, post-merge slot-to-loop validation, versioned OpenOOH identifiers, and canonical-format authority. Add the `dooh-motion-type` enum and supersede pricing-layer loop_duration_seconds in flat-rate-option.json.
