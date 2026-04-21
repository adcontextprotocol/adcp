---
---

fix(compliance): resolve OAuth creds for Test-your-agent instead of 401ing

`resolveOwnerAuth` collapsed OAuth entries into a bare bearer and dropped them entirely within 5 minutes of `expires_at`, so the dashboard's Test-your-agent flow hit "Missing Authorization header" right after a successful authorize. It now returns the full `{ type: 'oauth', tokens, client }` shape so the `@adcp/client` SDK can refresh via the stored refresh token + client credentials.

Also adds `resolveUserAgentAuth` on the registry route so Test-your-agent prefers the authenticated user's own org context (matching the "Auth configured via OAuth" the UI displays), then falls back to the owning-org lookup. Static bearer/basic credentials saved via the connect form are honored first; only OAuth entries with a refresh token are returned as the refreshable `oauth` shape.
