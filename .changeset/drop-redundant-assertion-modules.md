---
---

Delete `server/src/compliance/assertions/` now that `@adcp/client@5.9.1` ships a widened `context.no_secret_echo` default (adcp-client#752/#753) that walks the whole response body, matches suspect property names at any depth, and extracts secrets from structured `auth` objects. The local override #2771 added as a stricter stand-in while upstream was a no-op for structured auth is no longer pulling any weight.

- Delete `server/src/compliance/assertions/{context-no-secret-echo,index}.ts`.
- Drop the side-effect imports in `server/src/services/storyboards.ts`, `server/tests/manual/run-storyboards.ts`, `run-one-storyboard.ts`, `storyboard-smoke.ts`.
- Drop the `/dist/compliance/assertions/` `.gitignore` entry that was only relevant while the tsc output collided with the compliance-tarball path.
- Bump `@adcp/client` to `^5.9.1`.
- Refresh the `universal/idempotency.yaml` comment to point at the bundled 5.9+ defaults (auto-registered on `@adcp/client/testing` import; no loader required).

The SDK default now matches or exceeds the coverage the local override provided. Consumers who need stricter per-repo checks can use the new `registerAssertion(spec, { override: true })` option landed in adcp-client#752.

One residual scope shift worth flagging: the SDK's `SECRET_MIN_LENGTH` floor for verbatim secret-value hunting is 16 characters (vs the deleted override's 8) — a deliberate false-positive reduction since real bearer/OAuth/HMAC tokens are ≥20 chars. Short static fixture values (e.g., an 8-char placeholder api_key) are no longer matched by-value. The property-name check (`authorization` / `api_key` / `apikey` / `bearer` / `x-api-key`) at any depth remains the primary gate for those cases. Consumers staging sub-16-char credentials can re-register a stricter `context.no_secret_echo` via `registerAssertion(spec, { override: true })`.
