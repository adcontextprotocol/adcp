---
---

fix(aao): normalize `?status=` query encoding to repeated-key; accept both forms (#4855)

The `GET /v1/agents/{agent_url}/publishers` endpoint accepted only comma-separated
`?status=authorized,revoked` but the TS SDK (adcp-client#1892) correctly uses the
OpenAPI default of repeated-key (`?status=authorized&status=revoked`). Express delivers
repeated keys as `string[]`; the prior `typeof === 'string'` guard silently treated
them as a missing param and defaulted to `authorized`-only — a silent wrong-result bug.

The server now coerces `string[]` (repeated-key) to a joined string before splitting,
making both forms functionally equivalent. Docs updated to declare repeated-key as
normative; comma-separated noted as backward-compatible.
