---
---

feat(admin-tool): add "Import from registry" picker to adagents.json builder, closes #4114

Adds a curated search-and-select picker to `/adagents/builder` so publishers can
populate `authorized_agents[]` from known sales-agent platforms without knowing
endpoint URLs. Calls the existing `GET /api/registry/agents?type=sales` API,
sorts by publisher_count descending (legitimacy signal), and multi-selects into
the builder's agent list. Uses DOM textContent throughout for XSS safety.
`authorized_for` is intentionally left editable-empty per import; the user fills
it in when editing each card.
