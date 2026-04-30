---
---

Reject responses with `Content-Encoding ≠ identity|absent` on the smart-paste property parse URL fetch path. The compression-bomb defense in PR #3396 sends `Accept-Encoding: identity` to disable undici's auto-decompression — but if a hostile server ignores the header and ships gzip/br/deflate anyway, undici still decodes the body and the byte counter measures decompressed bytes, leaving the 1MB cap circumventable by a high-ratio bomb. The route now checks the response's `Content-Encoding` header and returns a 400 if anything other than `identity` (or absent) is present, so a non-cooperative server is rejected before any reading happens.

Also derives test fixture IDs from `process.pid + Date.now()` so the suite can run in parallel with other integration tests touching `organizations`/`users`/`brands` without FK-conflict races. Suggested by nodejs-testing-expert review on PR #3396.

5 new test cases pin the strict reject for gzip/br/deflate (case-insensitively), and confirm an explicit `Content-Encoding: identity` is still accepted.
