---
"adcontextprotocol": minor
---

Document the normative attestation-mode selection rule for upstream_traffic compliance checks.

Conforming runners now have one explicit raw-vs-digest decision order for query_upstream_traffic that preserves assertion coverage, including the non-JSON identifier_paths case where raw mode is required to avoid grading an otherwise evaluable assertion as not_applicable. Storyboard authors should rely on that rule instead of non-schema attestation-mode hints.

Closes #5080.
