---
"adcontextprotocol": patch
---

Public Suffix List (#8409, DR-0037): verifiers compute eTLD+1 with a PSL bundled with the verifier, ICANN and PRIVATE sections, never fetched at runtime, and refreshed through normal dependency updates. AdCP names no reference snapshot, and `security.mdx` no longer says two verifiers on different PSL versions are non-conformant against each other, or names PSL libraries. On the trust-record path, a verifier whose list lacks a newly added PRIVATE suffix fails closed. Spec R3a step 1, the threat table, L2 §Grants in trust records, and the trust.json `grantee` description now say the same.
