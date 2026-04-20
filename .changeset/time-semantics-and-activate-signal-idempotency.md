---
---

Add a Time Semantics section to `docs/building/implementation/security.mdx` normativizing timestamp format (ISO 8601 with explicit offset MUST; naïve timestamps rejected with `INVALID_REQUEST`; UTC recommended on the wire), interval semantics (half-open `[start, end)`), and daypart targeting semantics (three declared modes: buyer-declared IANA zone, publisher-local, viewer-local; ambiguous dayparts rejected). Add the missing `idempotency_key` row to the `activate_signal` task reference — the schema already required the field; the doc had drifted.

Closes #2395, #2396.
