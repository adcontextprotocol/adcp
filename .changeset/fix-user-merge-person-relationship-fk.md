---
---

Fix `mergeUsers` failing with FK 23503 (`addie_threads_person_id_fkey`) when both users have a `person_relationships` row. Repoint `addie_threads.person_id` and `person_events.person_id` to the primary's relationship before deleting the secondary's row, so the addie thread history follows the merge and `person_events` aren't silently CASCADE-deleted.

Also adds three previously-missing tables to the merge — `agent_test_runs`, `certification_expectations`, and `addie_prompt_telemetry` — so merged accounts no longer leak rows under the secondary's `workos_user_id`.
