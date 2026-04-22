---
---

feat(dashboard): "Test now" button for OAuth client-credentials save flow (closes #2809)

Operators pasting client_id/client_secret from their IdP console no longer have to wait for the next compliance heartbeat (15–60 minutes) to confirm the config works. After save, the form replaces itself with a save-confirmation + a **Test now** button that POSTs to a new dry-run endpoint, exchanges at the token endpoint, discards the resulting token, and renders the result inline in under 2 seconds.

**New endpoint.** `POST /api/registry/agents/:encodedUrl/oauth-client-credentials/test` — same auth + ownership gate as the save endpoint. Loads the saved credentials, calls `@adcp/client`'s `exchangeClientCredentials()`, returns one of:

- `{ ok: true, latency_ms }` on a clean exchange.
- `{ ok: false, latency_ms, error: { kind, message, oauth_error?, oauth_error_description?, http_status? } }` on failure. `kind` is the SDK's `ClientCredentialsExchangeError` discriminator (`oauth` / `malformed` / `network`) so UI can branch cleanly.

Same-origin response always `200 OK` — the error is in the payload, not the HTTP status, so the UI doesn't confuse "valid response saying exchange failed" with "our endpoint crashed."

**UI.** Inline button on the post-save state. Click → spinner → typed result:
- Success: `✅ Token exchange succeeded in Xms.`
- `oauth` failure: `❌ <message> (oauth) — AS returned invalid_client: <description> [HTTP 401]`
- `network` failure: `❌ <message> (network)`
- `malformed` failure: `❌ <message> (malformed)`

The form no longer auto-reloads after save — operators can test, fix, and re-save without losing state.

Verified via Playwright isolated test: 11/11 assertions pass (correct URL + method, latency rendering, oauth-error plumbing with description + HTTP status, network-error plumbing, client-thrown fetch errors). Server unit suite remains green (1802 passed).

Follow-up still open: [#2810](https://github.com/adcontextprotocol/adcp/issues/2810) — structured error codes on the *save* path would let the UI highlight which field triggered a rejection the same way this renders the AS's `oauth_error`.
