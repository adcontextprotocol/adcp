---
"adcontextprotocol": patch
---

spec(compliance): populate signals protocol baseline with real phases (#2356)

The `protocols/signals/index.yaml` baseline was a 3.1 placeholder with
`phases: []`, which meant every agent declaring
`supported_protocols: ["signals"]` saw "Signals track — SKIP (not applicable)"
regardless of how compliant its get_signals and activate_signal implementations
were. Compliance coverage for signals agents could only come from claiming a
specialism (signal-owned or signal-marketplace), which is not how
protocol-level baselines are supposed to work.

- Populates the baseline with three phases — capability_discovery, discovery
  (get_signals), and activation (activate_signal) — covering the subset of
  behavior that BOTH signal-owned and signal-marketplace specialisms depend
  on. Specialism storyboards continue to exercise their richer flows (pricing
  option selection, source discriminators, agent-vs-platform destinations,
  deactivation).
- Adds `required_tools: [get_signals, activate_signal]` so an agent declaring
  signals without exposing those tools produces a `missing_tool` skip reason
  (per the runner-output contract introduced in #2352) rather than the
  misleading `not_applicable`.
- Carries `context_outputs` from the discovery step through to activation so
  the activation step reuses the captured `signal_agent_segment_id` and
  `pricing_option_id` instead of hard-coded fixtures.

Bumps baseline version to 1.1.0 to mark the transition from placeholder to
runnable storyboard.
