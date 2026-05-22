---
---

fix(aao): pin `status=` query encoding for the directory inverse-lookup endpoint to repeated-key (`?status=authorized&status=revoked`), not comma-separated.

**Why.** PR #4828 defined `GET /api/v1/agents/{agent_url}/publishers` with a `status` query parameter but never pinned how multiple values are encoded on the wire. Both comma-separated single-value (`?status=authorized,revoked`) and repeated-key (`?status=authorized&status=revoked`) are common HTTP conventions, and OpenAPI's `style: form` produces one or the other depending on `explode`. Two interpretations in the wild means silent mis-filtering: a repeated-key request against a comma-only directory keeps the last value the parser sees; a comma-separated request against a repeated-key-only directory matches the literal string `"authorized,revoked"` and returns nothing.

**Decision.** Repeated-key. It is what `URLSearchParams.append()` produces, what OpenAPI's default `explode: true` produces, and what the TS SDK wrapper in adcp-client#1892 (merged) already ships. It composes cleanly with future values that might contain a comma. Comma-separated input is rejected at the directory with `400` rather than silently coerced — a same-origin parser bug that returns zero rows for a year is worse than an upfront error.

**Changes.**

- `docs/aao/directory-api.mdx` — `status` row in the query-parameter table now reads `string, repeated` and points to the repeated-key convention. Adds a worked example URL, TS/Python client snippets, and the OpenAPI fragment (`style: form, explode: true`). `400 Bad Request` row updated to mention comma-separated input as one of the rejection causes.

No schema change — the response envelope is unaffected. No SDK change — adcp-client#1892 already shipped the repeated-key form.

Resolves #4855.
