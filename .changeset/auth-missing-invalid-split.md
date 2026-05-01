---
"adcontextprotocol": minor
---

spec(errors): split `AUTH_REQUIRED` into `AUTH_MISSING` (correctable) + `AUTH_INVALID` (terminal)

`AUTH_REQUIRED` conflated two operationally distinct cases: missing credentials (genuinely correctable — agent provides creds and retries) and rejected credentials (terminal — expired/revoked tokens require human rotation, not auto-retry). A buyer agent honoring `correctable` on revoked keys will retry-loop, hammering seller SSO endpoints in a pattern indistinguishable from a brute-force probe.

**New codes:**
- `AUTH_MISSING` — `Recovery: correctable`. No credentials were presented; agent re-handshakes and retries.
- `AUTH_INVALID` — `Recovery: terminal`. Credentials were presented and rejected (expired / revoked / malformed signature). Requires human-driven credential rotation; auto-retry is counterproductive.

**Backward compat:** `AUTH_REQUIRED` is retained in the enum as a deprecated alias (recovery: correctable) during the 3.x deprecation window. Sellers MUST migrate to the split codes; agents MUST handle all three. The `error-code-aliases.json` linter registry now maps `AUTH_REQUIRED → AUTH_MISSING` so storyboard references emit warnings.

**Related:** adcp-client#1135 (TS SDK error-code drift fix that surfaced this spec gap), adcp-client#1147 (typed-error recovery alignment).

Closes #3730.
