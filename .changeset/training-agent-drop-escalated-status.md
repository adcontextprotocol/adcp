---
---

Training agent: drop non-spec `'escalated'` status from `check_governance` responses.

AdCP v3 governance has three terminal `check_governance` statuses (`approved` | `denied` | `conditions`) — the spec schema validates to this set. The training agent was still emitting a fourth `'escalated'` status on human-review paths (`human_review_required`, reallocation threshold exceeded), which is rejected by spec-compliant buyer validators.

Human review is now signalled via a `critical`-severity `human_review` finding on a `denied` decision. The buyer resolves review off-protocol and re-calls `check_governance` with `human_approval` to proceed. The audit-log summary keeps its `escalations[]` array and `escalation_rate` metric — now derived from checks that carry a `human_review` finding — and adds the spec-standard `statuses.human_reviewed` supplementary count.

Changes:
- `GovernanceCheckState.status` narrows to `'approved' | 'denied' | 'conditions'`; `escalation` field removed.
- `governance-handlers.ts` replaces the `shouldEscalate → status = 'escalated'` branch with a `humanReviewRequired` flag that adds a critical `human_review` finding, which derives `denied` through the existing severity rule.
- `buildCheckResponse` no longer emits the top-level `escalation` object (removed from the spec response schema).
- `get_plan_audit_logs` derives `escalations[]`, `escalation_rate`, and `statuses.human_reviewed` from the `human_review` finding category.
- Tool description and unit tests updated.

Partial fix for adcontextprotocol/adcp-client#589 — the SDK-side cleanup lands in that repo.
