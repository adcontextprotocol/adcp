---
---

Close three Tier-2 items from the truthfulness audit (#2385) in one pass:

- **Known Limitations page** (#2379) — new `docs/reference/known-limitations.mdx` consolidating explicit non-goals and deferred items across security, privacy, commerce, authentication, governance, and conformance. Draws from the Security Model's "What AdCP does not do in 3.0" section and adds follow-up issue links for tracked items.
- **Why-not FAQ expansions** (#2379) — new accordions in `docs/faq.mdx` for AAMP, "roll your own", and "use MCP directly without AdCP". Acknowledges AAMP honestly without overclaiming comparison; defers a formal technical comparison until AAMP's normative surface stabilizes.
- **Privacy Considerations unifier** (#2387) — new `docs/reference/privacy-considerations.mdx` providing a cross-protocol entry point for implementers and compliance reviewers. Names the privacy categories (minimization, separation, transport, residency, retention, processor/controller roles), summarizes per-domain posture, and links into existing deeper references (TMP privacy architecture, Security Model, governance).
- **Platform-agnosticism lint** — new `tests/check-platform-agnostic.cjs` scanning `static/schemas/source/**` for vendor tokens in normative property names. Wired into `test:platform-agnostic` and the `test` chain. The lint excludes the `ext` subtree and enum values; the `FIELD_ALLOWLIST` permits legitimate external-identifier references (`apple_podcast_id`, `apple_id`, `nielsen_dma`). Accompanying update to `docs/spec-guidelines.md#platform-agnosticism` generalizes the "external system identifiers" carve-out to cover field names as well as enum values.

Navigation updated in `docs.json` for both the current release group and the v3 beta includes.

Does not affect schemas or published protocol.
