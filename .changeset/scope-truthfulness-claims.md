---
---

Tighten three load-bearing claims audited in #2385:

- **Structural privacy separation** — scoped correctly to TMP. Added a privacy-posture table to `docs/protocol/architecture.mdx` distinguishing TMP (structural) from other domains (contractual).
- **Human-in-the-loop** — replaced prose with a normative task matrix. New "Human-in-the-loop by task" section in `docs/governance/embedded-human-judgment.mdx` names every state-mutating operation, whether the protocol mandates a human, and the mechanism. `docs/protocol/architecture.mdx` now links to it.
- **Platform agnosticism** — added a "Platform Agnosticism" rule to `docs/spec-guidelines.md` and a `CONTRIBUTING.md` pointer. Reviewers should now reject normative fields containing vendor tokens.

Does not affect schemas or published protocol; docs + contributor guidance only.
