---
---

Bucket A follow-ups from the training-agent 5.7 storyboard audit (PR #2631):

- **#2637 (second_cancel idempotency_key)**: added `idempotency_key` to `scenarios/invalid_transitions.yaml > double_cancel/second_cancel.sample_request`. Same pattern as the `recancel_buy` fix in PR #2631 — without the key, a conformant agent could reject for missing-key rather than `NOT_CANCELLABLE`, failing the step for the wrong reason.

- **#2635 (known-ambiguities entries)**: added four entries to `docs/building/implementation/known-ambiguities.mdx` so implementers hitting pre-fix symptoms on older SDK versions can find the resolution:
  - Rights-holder vs advertiser `brand_id` (#2627)
  - Re-cancel error code `NOT_CANCELLABLE` vs `INVALID_STATE` (#2617/#2619/#2628)
  - Branch-set step grading `peer_branch_taken` (#2629)
  - SDK `request-builder` override masking spec-conformant `sample_request` (#2626 / adcp-client#689)

#2636 (brand_rights compatibility-filtering assertion) was dropped from this bucket after discovering two missing primitives blocked the proposed negative-peer-phase approach. Filed as follow-ups: #2642 (cross-step comparison validation primitive) and #2643 (conflicting-brand test-kit fixture).
