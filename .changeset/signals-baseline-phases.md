---
"adcontextprotocol": patch
---

spec(compliance): populate signals protocol baseline + fix signal storyboard gaps (#2356)

The `protocols/signals/index.yaml` baseline was a 3.1 placeholder with
`phases: []`, which meant every agent declaring
`supported_protocols: ["signals"]` saw "Signals track — SKIP (not applicable)"
regardless of how compliant its get_signals and activate_signal implementations
were. Compliance coverage for signals agents could only come from claiming a
specialism, which is not how protocol-level baselines are supposed to work.

**Signals baseline**

- Populates the baseline with three phases — capability_discovery, discovery
  (get_signals), and activation (activate_signal) — covering the subset of
  behavior that BOTH signal-owned and signal-marketplace specialisms depend
  on. The activation phase has two steps (agent destination + platform
  destination) because the signals spec requires every signals agent to
  accept both destination types; testing only one lets a non-conformant
  agent pass.
- Adds `required_tools: [get_signals, activate_signal]` so an agent declaring
  signals without exposing those tools produces a `missing_tool` skip reason
  (per the runner-output contract in #2352) rather than the misleading
  `not_applicable`.
- Carries `context_outputs` from the discovery step through to activation
  so both activation steps reuse the captured `signal_agent_segment_id`
  and `pricing_option_id` instead of hard-coded fixtures.

**Signal specialism storyboard fix (bundled)**

- Every `activate_signal` sample_request in `specialisms/signal-owned` and
  `specialisms/signal-marketplace` was missing `idempotency_key`, which the
  request schema marks as required. The `@adcp/client` runner (post
  adcp-client#602) forwards `idempotency_key` from sample_request through
  the request builder instead of silently auto-injecting, so a missing key
  in the storyboard now produces a schema-invalid request. Added
  `idempotency_key: "$generate:uuid_v4#<alias>"` to all four activation
  steps so the runner resolves a deterministic UUID per step.

Baseline version bumped to 1.1.0 to mark the transition from placeholder
to runnable storyboard.
