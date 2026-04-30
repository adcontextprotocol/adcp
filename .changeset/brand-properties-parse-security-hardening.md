---
---

Harden the smart-paste property parse endpoint based on security review:

- Disable gzip/br auto-decompression on the URL fetch (`Accept-Encoding: identity`) so the 1MB streaming cap can't be bypassed by a compression bomb where a small encoded body decodes to many MB before the reader cancels.
- Escape literal `</content>` inside fetched URL bodies before XML-fence interpolation, narrowing the prompt-injection surface where a hostile origin could break out of the wrapper. Output filter (type allowlist + DNS length cap + lowercasing) remains the load-bearing defense.
- Replace the echoed `safeFetch` error string with a fixed `"Could not fetch URL"` for parity with the SSRF rejection path — no internal network details leak through 400s.
- Tighten the JSON fence-strip regex to tolerate leading whitespace + CRLF; an end-anchored match means a fence appearing mid-prose still falls through to the warning path rather than exposing partial extraction.

Adds 11 new integration test cases covering URL streaming branches (non-2xx, null body, fetch throw, Accept-Encoding header, `</content>` escape), the `relationship` enum (each of owned/direct/delegated/ad_network), and a negative fence test that pins mid-prose fences as non-matching.
