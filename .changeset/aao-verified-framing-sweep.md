---
---

docs(aao-verified): pre-3.1 framing consistency sweep

Reconciles AAO Verified (Spec)/(Live) framing across docs and queued changeset entries:

- Renames the "Two marks: AdCP Conformant vs AAO Verified" section in `aao-verified.mdx` to "Naming history" so cold readers see the current single-mark framing rather than a confusing two-marks heading; fixes a broken three-column table row in the same section.
- Replaces `⊆` containment notation in `conformance.mdx` with plain-English phrasing that makes the independent-axes framing explicit.
- Updates `.changeset/salty-wasps-cheat.md` to remove "Spec is a prerequisite for measuring Live" — that sentence directly contradicts the orthogonal-axes correction landed in #3536.
- Updates `.changeset/account-authorization-and-rbac-errors.md` to qualify `attestation_verifier` as binding to the "AAO Verified (Live) qualifier" rather than the unqualified "AAO Verified mark", since the scope specifically enables (Live) axis observability.

Refs #3564. Item 4 (attestation_verifier doc sweep conditional on #3561) remains open on the parent issue.
