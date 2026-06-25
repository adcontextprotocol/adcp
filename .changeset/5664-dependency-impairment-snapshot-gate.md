---
---

Empty changeset: Fix `dependency_impairment` and `dependency_impairment_cardinality` for #5664 on two fronts. (1) Gate both storyboards on `media_buy.propagation_surfaces` containing `snapshot`, so webhook-only / `out_of_band` sellers grade `not_applicable` instead of false-failing on the snapshot-coherence surface (wiring the opt-out the `propagation_surfaces` schema already documents). (2) Insert `list_creatives` re-reads after each `force_creative_status` rejection so the runner observes the offline status on the wire before the impaired `get_media_buys` read — without it the `impairment.coherence` ledger keeps the pre-rejection status and the scenario false-fails for every snapshot seller. Fixes #5664.
