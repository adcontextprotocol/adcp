---
"adcontextprotocol": patch
---

Training agent implements the rc.3 Reliable Reporting consumer-status hardening and the conformance storyboard grades it.

The public training agent now advertises `consumer_status_task`, serves
`sync_reporting_status`, and projects the full RC.3 contract: `content_mismatch`
with its closed `mismatch_code`, `obligation_counts.consumer_status_pending`,
issue `opened_at` / `issue_state` / `external_ref`, and the
`operations_contact` / `consumer_mismatch_escalation_seconds` capability fields
driving `recommended_action` escalation — with the escalation boundary taking
precedence over the stale-`received` grace deadline.

`comply_test_controller`'s `reporting_core_lifecycle_probe` gains two additive
operations, `advance_past_status_deadline` and `advance_past_escalation`, and
the capability-gated `reporting_consumer_status` storyboard uses them to grade
counted silence, each `mismatch_code`, `opened_at` stability across the
severity change, escalation to a `contact_*` action, and `operations_contact`
presence.
