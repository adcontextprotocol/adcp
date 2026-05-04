---
"adcontextprotocol": minor
---

Add a per-agent REST surface at `/api/me/agents` so members can register, list, update, and remove individual agents from CI or scripts via WorkOS API key (Bearer `sk_…`) — no full-profile round-trip and no Addie/UI dependency. Reuses the same visibility gate, server-side type resolution, and audit log as `PUT /api/me/member-profile`. Writes serialize through `SELECT … FOR UPDATE` on `member_profiles` so concurrent register/update/delete calls cannot race the JSONB read-modify-write. `DELETE /api/me/agents/{url}` returns `409 unpublish_first` when the agent is currently `public` so the registry catalog and the published `brand.json` cannot silently disagree. `PATCH /api/me/agents/{url}` with a body `url` that disagrees with the path returns `400 url_immutable` rather than dropping the rename silently.
