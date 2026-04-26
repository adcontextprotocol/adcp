---
---

Fix the "Show on registry" toggle on the Agents dashboard. The `/api/registry/agents/{url}/compliance` endpoint now returns `compliance_opt_out` so the checkbox reflects the persisted state on page refresh. The toggle's change handler is also scoped to a dedicated `registry-visibility-toggle` class so clicking "Pause automated checks" no longer accidentally flips registry visibility, and the card re-renders after a successful change so the status label updates immediately.
