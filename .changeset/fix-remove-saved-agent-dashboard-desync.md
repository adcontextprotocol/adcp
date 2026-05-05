---
---

fix(addie): `remove_saved_agent` now also drops the entry from `member_profiles.agents` so `/dashboard/agents` stops showing the phantom row after deletion. Previously it only deleted from `agent_contexts`, leaving the dashboard JSONB out of sync — the inverse of the desync #4064 closed on the save side. Also lets users clean up stale dashboard rows where `agent_contexts` is already empty (Philippe Giendaj, escalation #313 follow-up). Refuses to drop a `public` agent without first changing visibility to private, matching `DELETE /api/me/agents/:url`'s brand.json safety rule.
