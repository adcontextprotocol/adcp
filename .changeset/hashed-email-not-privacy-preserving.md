---
"adcontextprotocol": patch
---

Stop describing unsalted `hashed_email` and `hashed_phone` as privacy-preserving (closes #2454).

Unsalted SHA-256 of the email or E.164 namespace is recoverable via precomputed dictionaries — it is pseudonymous PII, not anonymous. Schema descriptions, the glossary entry, and `sync_audiences` privacy language now say so explicitly, and `privacy-considerations.mdx` adds a normative section: unsalted hashed identifiers MUST NOT be described as privacy-preserving, MUST be treated as PII for retention/consent/DSAR/erasure, and a privacy-preserving match requires a recognized primitive (salt, HMAC, PSI, or TEE). No wire-format change — identifiers, patterns, and required fields are unchanged.
