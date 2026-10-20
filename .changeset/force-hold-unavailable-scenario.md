---
"adcontextprotocol": patch
---

Add the experimental `force_hold_unavailable` `comply_test_controller` scenario (`media_buy.hold_policy`). It makes the next `refine_proposals` finalize of a named draft proposal fail with `hold_unavailable`, fails its batch siblings with `batch_aborted`, and then consumes the directive, so a runner can reach the all-or-none hold-failure path without a real seller running out of inventory. Registration returns the existing forced-directive response with a new `unable` arm value and a `forced.proposal_id` echo. The hold-policy test vectors also gain installment `booking_deadline` and `change_cutoff` hold caps, exact-retry replay of a finalize, and multi-entry `extend_hold` batches. Storyboards follow once the training agent serves 3.3. Refs #8182.
