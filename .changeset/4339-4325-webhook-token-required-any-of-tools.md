---
"adcontextprotocol": minor
---

spec: webhook token round-trip + storyboard `required_any_of_tools` (closes #4339, #4325)

Two additive 3.1.0-beta.2 blockers bundled. Both are non-breaking — existing senders and receivers continue to interoperate.

**#4339 — webhook authentication `token` round-trip (`static/schemas/source/core/`)**

- `mcp-webhook-payload.json` — promote the echoed authentication `token` to a typed optional property (`minLength: 16`, `maxLength: 4096`). The field previously traveled on the wire under `additionalProperties: true`; this is purely a typed surface on an existing implicit contract. Schema-driven SDK clients can now access `payload.token` without falling through an extras path. Receivers that configured a token MUST compare it to this value to validate request authenticity, and SHOULD use a constant-time equality check to mitigate timing attacks. The length-check fast-path is forbidden — receivers MAY range-check token length only after subscription lookup and never as a short-circuit on equal-length inputs.
- `push-notification-config.json` — add `maxLength: 4096` to the existing `token` field (was previously only `minLength: 16`); this is a constraint addition on the upper bound, not a tightening of the lower bound that would reject existing-conformant configs. Cross-reference the payload-side validation obligation. Add downgrade-defense sentence: receivers that registered both an RFC 9421 signing key and a `token` MUST NOT treat a valid token echo as authorization to skip signature verification. Clarify that `token` is NOT on the 4.0 removal track (only the legacy `authentication` block is being removed in favor of RFC 9421).

**#4325 — storyboard `required_any_of_tools` declarative one-of-N gate (`static/compliance/source/universal/`)**

- `storyboard-schema.yaml` — add `required_any_of_tools` as a top-level optional storyboard field. Each entry is an OR-family `{ tools: string[] (minItems: 2), rationale?: string }`. Multiple entries AND-combine. Distinct from `required_tools` (lenient any-of coverage skip) and `provides_state_for` (step-scope state substitution).
- `runner-output-contract.yaml` — extend `requirement_unmet` with the canonical `detail` sub-reason prefix `missing_required_tool_family:` plus the literal wire shape for separators (`" or "` between family members, `"; "` between multi-gate aggregations). No new top-level `skip_result.reason` enum value — the contract version stays at 2.2.0. Aggregator guidance is human-display only; automated consumers SHOULD parse only the first sub-reason from aggregated `detail` and surface multi-gate state separately.
- `scripts/build-compliance.cjs` — validate the field on specialism `index.yaml` files (filter+trim `tools[]` before `minItems:2` enforcement; reject non-string `rationale`; drop empty `rationale` after trim) and hoist into `compliance/<version>/index.json` for downstream SDK consumption.

**Downstream pickups (tracked separately):**

- `adcontextprotocol/adcp-client-python#638` — drops the `extra='allow'` token round-trip path once types regenerate against this schema.
- `adcontextprotocol/adcp-client#1481` — drops `examples/hello_si_adapter_brand.ts` top-level `offering_id` mirror once the 3.1.0-beta.2 dist publishes (the SI capture-path fix shipped in #3937 / dist 3.1.0-beta.1).
- `adcontextprotocol/adcp-client#1642` — migrates the runner-level account-discovery conformance gate (#1624) to per-storyboard `required_any_of_tools` consumption.

**Known follow-ups (filed as issues, non-blocking on this beta):**

- `minLength: 16` on both `token` fields permits ~96-bit base64url credentials, below the 128-bit entropy SHOULD in the description. Raising the floor to 22 would tighten an existing field; the gap is intentional for backward compatibility and re-evaluated in 4.0.
- `docs/building/by-layer/L3/webhooks.mdx` token-echo subsection and `whats-new-in-3-1.mdx` / `migration/prerelease-upgrades.mdx` entries are pending. Schema descriptions carry normative weight; the docs page catches up in a follow-up PR.
