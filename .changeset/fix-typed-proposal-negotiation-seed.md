---
"adcontextprotocol": patch
---

Repair the `typed_proposal_negotiation` compliance storyboard so it can pass against a conformant 3.2 seller. The seed step now calls `request_proposals` (the 3.2 proposal-lifecycle tool, as `declined_proposal_refinement` does) instead of legacy `get_products`, so the proposal it targets is one `refine_proposals` can resolve; the storyboard is gated on the seller advertising `request_proposals` in `media_buy.lifecycle_tools` and on `comply_test_controller`, and declares `controller_seeding: true` so its fixture products are seeded. The `unsatisfied_constraints` `field_contains` check addresses array elements with `[*]`, and each post-seed phase now names its upstream phases with `depends_on`, so a capability-gated phase the seller does not support (for example the unsupported-dimension rejection when the seller declares `flight`) skips alone instead of cascade-skipping finalize, accept, amendment, cancellation, and batch coverage.
