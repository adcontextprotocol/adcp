---
---

Add a per-agent REST surface at `/api/me/agents` so members can register, list, update, and remove individual agents from CI or scripts via WorkOS API key (Bearer `sk_…`) — no full-profile round-trip and no Addie/UI dependency. Reuses the same visibility gate, server-side type resolution, and audit log as `PUT /api/me/member-profile`.
