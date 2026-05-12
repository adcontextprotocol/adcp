---
---

adagents.json builder: fix 6 validation + UX issues from expert review of #4415.

1. `importFile` now runs a validation pass on import: normalizes country codes (uppercase, dedup), warns about malformed encryption key x values, normalizes contact.domain to lowercase, shows a summary alert for any coerced entries. Reference-only stubs (authoritative_location with no authorized_agents) now refuse to import with a helpful message.
2. Countries in `saveAgent`: `.filter(Boolean)` prevents empty tokens from trailing/double commas aborting save; `[...new Set(...)]` deduplicates before schema uniqueItems validation.
3. Half-filled encryption key rows (kid without x or vice versa) now alert with the row index at save time rather than silently dropping the row.
4. Signing key JSON parse failures now alert with the row index at save time instead of silently omitting the key.
5. `contact.domain` normalized to lowercase on save (schema requires lowercase host syntax).
6. `adagents-manager.test.ts`: 5 new tests for v3 fields round-tripping through `createAdAgentsJson` and `validateProposed` (exclusive, countries, effective dates, signing_keys).
7. `renderAgents` template literal: escaped agent.url, authorized_for, delegation_type, tagNames, propNames with `escapeHtml()` to close a self-XSS vector on imported malicious files.

Refs #4421.
