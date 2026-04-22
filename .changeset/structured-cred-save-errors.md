---
---

feat(dashboard): structured error codes on OAuth client-credentials save (closes #2810)

Before: a save rejection rendered the raw server string at the bottom of the form — accurate, developer-flavored, and disconnected from the field that caused it. Non-engineer operators saw `oauth_client_credentials.client_secret: $ENV references must match pattern $ENV:ADCP_OAUTH_<NAME>...` and had to parse that themselves.

After: the parser tags every rejection with a `{ code, field }` pair; the UI maps `code` to operator-friendly prose and red-outlines + scrolls to the offending input. The raw server string stays in the API response as `error` for engineers copy-pasting into tickets.

- **Parser.** `parseOAuthClientCredentialsInput` result on failure now has shape `{ ok: false, error, code, field }`. Codes (`invalid_blob_shape` / `missing_field` / `invalid_field_type` / `field_too_long` / `invalid_url` / `invalid_env_reference` / `invalid_auth_method_value`) and fields (`oauth_client_credentials` / `token_endpoint` / `client_id` / `client_secret` / `scope` / `resource` / `audience` / `auth_method`) are stable — UI localization and telemetry both key off these.
- **REST endpoint.** `PUT /oauth-client-credentials` returns `{ error, code, field }` on 400 (backwards-compatible — adds fields, doesn't change semantics of `error`).
- **OpenAPI.** New `CredentialSaveValidationErrorSchema` shape wired into the 400 response — the generic `ErrorSchema` stays untouched for everything else.
- **Addie tool handler.** Unchanged. The parser still returns a string `error` that the tool forwards to the LLM; the `code` / `field` are available but unused there (LLM handles prose fine).
- **Dashboard form.** New code-to-prose map + `.agent-cc-field-error` outline style. Successful saves and unknown codes clear any prior highlights; legacy 400s (no `code`) fall back to the old throw path.

Tests:
- **Parser unit (37 passing, +17 new):** every rejection case gets an assertion on `code` + `field` + non-empty `error`.
- **Playwright UI (12 passing):** friendly message replaces raw string, correct field outlined, retry clears prior highlights, unknown code falls back to raw error, legacy 400 works, success leaves no residual highlight.

Open: #2810.
