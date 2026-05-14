---
---

Server: `GET /api/me/member-profile` re-derives `primary_brand_domain` via the brand-domain resolver and emits `agent_visibility_gate: { can_publish_publicly, reasons[] }` so the dashboard's "Public" visibility toggle reads from the same gate the publish endpoint enforces. Stage 2 of #4159 dropped the column the dashboard had been inferring the gate from, silently greying out the toggle for every Builder/Member/Leader since #4313 shipped.
