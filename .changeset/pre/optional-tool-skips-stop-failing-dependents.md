---
"adcontextprotocol": patch
---

In three storyboards, a skipped optional tool no longer causes the stateful steps after it to fail.

- `provenance_audit_observation` (1.1.0): both audit-observation reads declare `sync_creatives`, the tool whose state they read, and each runs in its own phase after the sync. Sellers without `sync_creatives` skip the sync and both reads instead of failing them, and their verifier discovery is still graded.
- `create_media_buy_async_lifecycle` (1.1.0): each optional `get_task_status` and `list_tasks` read runs in its own phase, after the submit or completion phase it depends on. The completed-task reads keep the `force_task_completion` gate. A missing read no longer blocks the other read or the controller completion.
- `governance_agent_binding_acceptance` (1.1.0): the optional `comply_test_controller` read and the recovery `sync_governance` each run in their own phase after account setup. Sellers without the controller still have their recovery graded.
