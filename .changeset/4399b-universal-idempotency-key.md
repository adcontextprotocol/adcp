---
"adcontextprotocol": minor
---

spec(security): require `idempotency_key` on every AdCP task request — read and mutating alike.

Follow-up to #4399 (MCP tool wrapper envelope tolerance) — the deeper question that surfaced once that fix landed: why does this category of bug exist at all? Sellers reject `idempotency_key` on `get_products` because the contract framed it as a "mutating-only" envelope field, but `get_products` is polymorphic:

- `buying_mode: 'brief'` / `'wholesale'` resolves as a pure read most of the time.
- The same tool MAY return a `Submitted` envelope when curation requires upstream queries or HITL — that's async-task creation, which is mutation territory.
- `buying_mode: 'refine'` with `action: 'finalize'` is a commit that transitions a proposal to committed with an `expires_at` hold window (see #4107).

Buyers cannot predict at call time which mode the seller will resolve. So the rule "send `idempotency_key` on mutating requests only" required classification the buyer can't do, and the rule "sellers reject mutating requests that omit it" left sellers tripping over reads that turned into mutations or carried the field uniformly.

The simpler rule: `idempotency_key` is required on every AdCP task request, period. Read and mutating alike. The buyer no longer classifies; the seller no longer rejects on the read/write distinction; the polymorphism on `get_products` (and any future tool that gains hybrid read/write modes) stops being a wire-contract footgun.

For calls that resolve as pure reads, the cache provides byte-stable replay-on-retry within the TTL — harmless and gives buyers a uniform retry-safe contract. For calls that resolve as async-task creation or commit, the cache provides the same at-most-once guarantees as on mutating tasks. The rate-limit ceiling in rule 8 already accounts for high-volume traffic; read traffic adds to insert rate but the ceiling is tunable per operator.

Files (`docs/building/by-layer/L1/security.mdx`):
- §Idempotency rule 1 lead — "required on every AdCP task request — read and mutating alike". Drops the long list of mutating task names (the list was always going to drift as new tools shipped).
- New `**Why universal — including read tools.**` paragraph naming `get_products`'s polymorphism as the canonical case.
- §Response-level replay indicator — "responses to any request that resolved via the idempotency cache" (was "responses to mutating requests").
- §Buyer obligations / "When the seller's capability declaration is missing" — fail-closed now applies to every AdCP task request, with explicit reasoning about why pure-read calls aren't exempt under polymorphism.
- §Server-side tool wrapper conformance (added in #4399) — `idempotency_key` line tightened from "MUST accept and ignore on read tools" to "MUST accept it; the idempotency layer routes it per rules 2-9".

Why this over keeping the mutating-only rule and just fixing #4399's wrapper bug:
- The wrapper bug was a symptom of the binary contract being wrong-shaped. Patching the symptom (sellers must accept envelope fields) without fixing the binary leaves future polymorphic tools (anything that can return Submitted) hitting the same class of failure.
- "Cleaner and simpler" beats "send-on-mutating-only" once the polymorphism exists — the buyer's SDK doesn't need a read-vs-write classifier and the seller's wrapper doesn't need to know which mode a call resolved into before it sees the key.
- Cache-growth concern bounded by rule 8 (per-agent insert ceiling); the recommended numbers were sized for realistic high-volume launch patterns and remain tunable.

Refs #4399. Supersedes the "MUST tolerate on read tools" carve-out — `idempotency_key` is now required, not tolerated.
