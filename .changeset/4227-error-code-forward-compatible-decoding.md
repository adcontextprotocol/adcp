---
"adcontextprotocol": minor
---

spec(errors): make `error.code` forward-compatible decoding normative.

The drift lint shipped in #4221 enforces a strict policy: adding a new code to `error-code.json` is a wire change held to the next minor, because a 3.0.x receiver decoding a 3.1 sender's `error.code` has no contract that says it must accept the unknown value. The closed-enum hazard was prose-level in `error-code.json` ("agents MUST handle unknown codes gracefully by falling back to the recovery classification") but not surfaced as a normative receiver rule in the spec body — strict validators reading `core/error.json` would have rejected unknown codes anyway. `core/error.json` already types `error.code` as `string` (not as a closed enum reference), so the wire was already open at the envelope level; what was missing was the receiver contract that says so explicitly, and the sender contract that says `error.recovery` is the normative carrier across version skew.

This change makes that explicit:

- **Receivers MUST decode unknown codes**, recover the recovery class from `error.recovery`, and default to `transient` when `recovery` is absent (matches the manifest's `error_code_policy.default_unknown_recovery`).
- **Senders MAY emit codes outside the receiver's pinned vocabulary** — newer codes, platform-specific codes — and MUST populate `error.recovery` on every error from 3.1 onward so receivers across version skew can classify reliably.
- **`error.recovery` is the normative wire carrier**; `enumMetadata.recovery` in `error-code.json` is the documentary mirror for known codes.

3.0.x policy unchanged — 3.0.x receivers predate this rule, so 3.0.x stays wire-stable for the rest of its support window. From 3.1 onward, future maintenance lines can ship new codes additively (3.1.5 adds a code; 3.1.0 receivers handle it via `error.recovery`) instead of every code being held to the next minor.

Files:
- `static/schemas/source/core/error.json` — `error.code` description elevated from "agents MUST handle unknown codes" prose to a wire-level rule pointing at `error-handling.mdx#forward-compatible-decoding-normative`. `error.recovery` description states it as the normative carrier across version skew.
- `docs/building/by-layer/L3/error-handling.mdx` — new `### Forward-compatible decoding (normative)` section under `## Standard Error Codes` with the full receiver / sender / `error.recovery` contract and the "why this matters" / "3.0.x policy unchanged" carve-outs. Best-practice list item updated to point at the new section.

Refs #4227. Pairs with #3725 / #3738 (`enumMetadata.recovery`) and #4221 (the drift lint).
