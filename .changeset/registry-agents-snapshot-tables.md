---
---

Materialize agent health + capabilities into `agent_health_snapshot` and `agent_capabilities_snapshot` tables, written by the crawler and bulk-read by `GET /api/registry/agents`. Replaces the live MCP/A2A fan-out on every registry page load (which would hang when any single agent was slow) with two DB queries, matching the existing compliance-status pattern.
