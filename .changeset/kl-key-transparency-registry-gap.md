---
---

Add a "No key-transparency anchoring in the registry" bullet to `docs/reference/known-limitations.mdx` under Authentication and identity. The AgenticAdvertising.org registry resolves brand/property/agent identity and caches `signing_keys[]` from `adagents.json`, but it does not operate as a key-transparency log — no enrollment ceremony, no append-only rotation record, no cryptographic commitment that all verifiers see the same key history. 3.x is trust-on-first-use with continuity; a key-transparency layer is tracked for 4.0. Extracted from PR #2433.
