---
"adcontextprotocol": patch
---

verification: cleanup follow-ups after #3524 ships.

**Docs.** `docs/building/aao-verified.mdx` was last updated for the orthogonal-axes framing (#3536) but didn't mention the per-version model that #3524 just shipped. Updated:

- New "Per-version badges" section explaining that each badge is identified by `(agent, role, AdCP version)`, agents can hold parallel-version badges, and version-pinned vs. legacy URL behavior.
- "Display" section now documents both URL shapes (`/badge/{role}.svg` auto-upgrade and `/badge/{role}/{version}.svg` version-pinned), with examples for each.
- JWT claim block adds `adcp_version` and explicit verifier guidance ("verifiers MUST check `adcp_version` against the AdCP version they care about" — closes the cross-version replay concern raised in the Stage 2 security review).
- "Registry filter" section gains a "brand.json enrichment" subsection documenting the `aao_verification.badges[]` array, the `roles[]` / `modes_by_role` deprecation notice, and the AdCP 4.0 removal target.

**Refactor (testability).** `enrichAgentEntries`'s shaping logic was a closure inside the brand.json route handler — unreachable from unit tests. Extracted to `services/aao-verification-enrichment.ts` as `buildAaoVerificationBlock(badges)`. The route handler keeps the JSON traversal and assignment; the builder is a pure function with 14 new unit tests covering empty input, single-badge, multi-version dedupe (caller-ordering preserved), modes_by_role flattening (the "buyer pinned to 3.0 sees the wrong contract" footgun), adcp_version shape filtering (defense in depth), and the deprecation notice content. Code-review nit on PR #3604.

**Trivia.** `PROTOCOL_LABELS` in `dashboard-agents.html` gained a comment pinning the invariant that label values must not end in "Agent" (otherwise `${protocol} Agent${versionSegment}` would produce "Media Buy Agent Agent 3.1"). DX expert nit from #3603.

What this PR does NOT change:
- Wire format on any surface — the brand.json enrichment output is byte-for-byte identical to what shipped in #3604.
- Panel UX — role grouping and "show all versions" disclosure (#3603) explicitly defer until parallel-version badges land in production and we have real buyer feedback to design against.
