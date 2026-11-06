---
"adcontextprotocol": minor
---

Withdraw `forced.proposal_id` and the `unable` value of `forced.arm` from the `comply_test_controller` response in 3.3 (adcp#8501, entry 1). The experimental `force_hold_unavailable` scenario (`media_buy.hold_policy`) now returns the proposal ID in `simulated.proposal_id` on the `SimulationSuccess` branch, which holds the values a call injected or applied. The `forced` object is closed, and a minor release does not add to a closed schema (DR-0036), so `ForcedDirectiveSuccess` goes back to its 3.2 shape: arms `submitted`, `completed`, `input-required` and `rejected`, and no `proposal_id`.

**Both values shipped in `3.3.0-beta.0` through `3.3.0-beta.4` and are removed after beta.4.** This is a beta-to-beta change, not a change to a stable release. Those betas are immutable, so a seller or SDK built from one of them that answers `force_hold_unavailable` with `forced: { arm: "unable", proposal_id }` should answer `simulated: { proposal_id }` instead. Nothing else about the scenario changes: its request, its errors, and what the next finalize returns stay the same.

The `media_buy_seller/hold_unavailable_batch` storyboard reads the proposal ID from `simulated.proposal_id`, and the training agent returns it there.
