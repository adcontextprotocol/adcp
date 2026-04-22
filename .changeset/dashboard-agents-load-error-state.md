---
---

Fix agents dashboard so rate-limited or failing compliance fetches no longer masquerade as "not yet checked". Non-200 responses from the per-agent compliance endpoint now surface a distinct "couldn't load — Retry" card, with a one-shot retry that honors `Retry-After` on 429s. The "not yet checked" state is reserved for genuine `status: "unknown"` responses from the server.
