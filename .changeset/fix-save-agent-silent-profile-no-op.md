---
---

fix(addie): `save_agent` no longer silently no-ops when the org has no member profile yet. The handler now auto-creates a private member profile (via the new `ensureMemberProfileExists` helper) before adding the agent, and the user-facing response reports honestly when the dashboard write fails instead of always claiming success. Closes the case behind escalation #309 where Warren Fernandes saw "✅ added to your dashboard" but the agent was missing on `/dashboard/agents`.
