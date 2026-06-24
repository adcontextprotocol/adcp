---
---

Empty changeset: Gate the `dependency_impairment` and `dependency_impairment_cardinality` storyboards on `media_buy.propagation_surfaces` containing `snapshot`, so webhook-only and `out_of_band` sellers grade `not_applicable` instead of false-failing on the snapshot-coherence surface — wiring the opt-out the `propagation_surfaces` schema already documents. Fixes #5664.
