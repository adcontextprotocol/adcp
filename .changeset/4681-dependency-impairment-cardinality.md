---
"adcontextprotocol": minor
---

New `media_buy_seller/dependency_impairment_cardinality` scenario — pressure-tests the `impairment.coherence` inverse rule under cardinality. The base scenario tests forward + inverse + health-iff with one creative on one package, which a buggy seller can pass by emitting any impairment entry whose `resource_id` matches a known-rejected creative. This scenario asserts the seller emits the **right number** of entries, each pointing at the **right resource**.

Five phases, two creatives (A, B) on two packages (package_a, package_b):
1. **setup** — create buy with two packages, sync both creatives, assign each to its own package, baseline both at `approved`. Cardinality 0.
2. **reject_first_cardinality_one** — force A to rejected. Assert exactly one impairment, `resource_id: A`, `package_ids` contains `package_a` only. Catches sellers that emit `package_ids: [package_a, package_b]` (over-scoping) or duplicate entries.
3. **reject_second_cardinality_two** — force B to rejected. Assert two impairment entries. Catches sellers that merge entries.
4. **recover_first_via_swap** — swap `package_a` binding from A to fresh creative C. Cardinality back to 1. Catches sellers that don't decrement on swap recovery.
5. **recover_second_via_swap** — swap `package_b` binding from B to fresh creative D. Cardinality back to 0.

Failure modes caught beyond the base scenario:
- Wrong resource_id on an impairment (right cardinality, wrong target).
- Single impairment with `package_ids` inflated to both packages when only one creative is rejected.
- Failure to decrement `impairments[]` when an impairment clears partially via swap recovery.

Wired into `protocols/media-buy/index.yaml#requires_scenarios`. Sellers without `comply_test_controller force_creative_status` or without multi-package support grade `not_applicable`. Same capability gating as the base scenario (`capabilities.media_buy.impairment_propagation: "snapshot"` required for grading).

Closes #4681.
