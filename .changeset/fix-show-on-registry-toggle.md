---
---

Fix the "Show on registry" toggle on the Agents dashboard. The `/api/registry/agents/{url}/compliance` endpoint now returns `compliance_opt_out` so the checkbox reflects the persisted state on page refresh. Also scopes the toggle's change handler to a dedicated `registry-visibility-toggle` class so clicking "Pause automated checks" no longer accidentally flips registry visibility.
