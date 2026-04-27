---
---

Add `catalog_agent_authorizations` schema, `seq_no` rotation trigger,
`v_effective_agent_authorizations` view, and one-time backfill from
`agent_property_authorizations` + `agent_publisher_authorizations`.
Schema-only — no readers or writers wired yet.

Gates the writer + reader cutover (PR 4b) and the change-feed extension
(PR 4b-feed) for agent → publisher / agent → property authorizations,
following the design pinned in `specs/registry-authorization-model.md`.

Refs #3177.
