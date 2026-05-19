---
---

fix(addie): normalize Basic auth_token at save time + fail loudly on malformed storage

Addie's `save_agent` previously stored whatever string the user submitted for `auth_type: 'basic'`, even when the value was plain `user:password` rather than base64. The downstream `buildAuthOption` helper then tried to base64-decode the stored value, found no `:` in the decoded bytes, and silently re-classified the credential as bearer — putting `Authorization: Bearer user:pass` on the wire. The agent rejected, and the user saw a misleading "agent didn't declare capabilities" error pointing at the wrong party.

**Two changes in `server/src/addie/mcp/member-tools.ts`:**

1. **`save_agent` normalizes Basic input.** Accept either raw `user:password` or already-base64-encoded form and persist the base64-encoded form. The `:` character is not in the base64 alphabet, so its presence in the submitted value unambiguously identifies raw input. Aligns with the CLI (`--auth user:pass`), SDK (`createTestClient({username, password})`), and the dashboard's connect form — all of which accept raw input. Rejects with a clear error when the value is neither shape, so a malformed credential never lands in the DB.

2. **`buildAuthOption` no longer silently downgrades.** When a stored Basic credential fails to decode to a `:`-containing pair (legacy rows from before normalization, or corruption), the function now logs a warning and returns `undefined` instead of re-classifying as bearer. The request goes out unauthenticated, which lets the auth-failure diagnostic added in #4807 correctly point the user at re-saving credentials.

Also updates the `auth_type` schema description to document the new contract.

Pairs with #4807 (reporting-layer fix). Both together close the chain that propagates an upstream Basic-auth bug into "your agent is misconfigured."

Closes #4806.
