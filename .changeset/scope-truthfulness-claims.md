---
---

Tighten three load-bearing claims audited in #2385:

- **Structural privacy separation** — scoped correctly to TMP. Added a privacy-posture table to `docs/protocol/architecture.mdx` distinguishing TMP (structural) from other domains (contractual or per-session consent), and noting that governance gating is orthogonal to privacy posture.
- **Human-in-the-loop** — reframed as two protocol principles in `docs/governance/embedded-human-judgment.mdx`: (1) any mutation may be taken async via the task lifecycle (universal), and (2) campaign governance (`sync_plans` + `check_governance`) is the declarative buyer-side review channel. Operations governed by campaign governance now match the phase table in `docs/governance/campaign/specification.mdx` (`create_media_buy`, `acquire_rights`, `activate_signal`, `build_creative` in purchase; `update_media_buy`, `update_rights` in modification).
- **Platform agnosticism** — added a "Platform Agnosticism" rule to `docs/spec-guidelines.md` distinguishing vendor-named fields (disallowed at normative top level) from enum values naming external systems/formats/identifier spaces (allowed). Added a pointer from `CONTRIBUTING.md`.

Does not affect schemas or published protocol; docs + contributor guidance only.
