---
"adcontextprotocol": minor
---

Add typed proposal negotiation compliance storyboard.

- Add `typed_proposal_negotiation.yaml` exercising the AdCP 3.2 typed
  negotiation lifecycle through `refine_proposals`: capability-gated
  constraint satisfaction (total_budget, product_changes, alternatives),
  partial invariant, unsupported dimension rejection, finalize atomicity,
  idempotent replay, immutable lineage, digest-verified acceptance,
  amendment, cancellation, double-finalize rejection, and multi-source batch.
- Register the scenario in the media-buy seller `index.yaml`.

Refs #6559
