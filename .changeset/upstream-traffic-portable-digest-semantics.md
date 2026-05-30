---
---

feat(compliance): clarify upstream_traffic digest length and identifier path grammar

Pins two portable-runner semantics for the 3.1 `upstream_traffic` contract:

- `recorded_calls[].payload_length` in digest mode is the byte length of the exact body bytes covered by `payload_digest_sha256`: RFC 8785 (JCS) canonical bytes for JSON-shaped content after redaction, or post-redaction raw body bytes for non-JSON content. It is not the original outbound body length before parsing, redaction, or canonicalization.
- Storyboard `identifier_paths` use request-payload-relative dotted paths with optional `[*]` array wildcards on path segments. Runners/controllers must reject bracket-quoted keys, numeric indexes, recursive descent, explicit roots, empty segments, and reserved roots such as `request.*`, `response.*`, and `context.*`. A new build-time lint enforces the grammar for the shared storyboard corpus.

Closes #5072 and #5073.
