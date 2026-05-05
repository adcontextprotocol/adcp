---
---

feat(dashboard-agents): surface a Delete action on each agent card.

`/dashboard/agents` now exposes a Delete button on every agent card (loadError,
not-yet-checked, and full-compliance variants). It calls `DELETE /api/me/agents/:url`
and on the 409 `unpublish_first` response (public agents are reflected in
brand.json) prompts the user to flip visibility to private and retries the
delete. Removes the agent from `pageState` and re-renders without a full reload.
