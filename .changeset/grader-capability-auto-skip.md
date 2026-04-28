---
---

`grade_agent_signing` now auto-skips request-signing vectors whose `verifier_capability.covers_content_digest` doesn't match the agent's declared mode — the CLI-side reimplementation of the grader's in-process `agentCapability` option, which the CLI surface doesn't expose. Default behavior anonymously probes `get_adcp_capabilities` and reads `request_signing.covers_content_digest`; callers can short-circuit with `content_digest_mode: 'either' | 'required' | 'forbidden'` when probing fails (auth-gated routes).

Validated against `https://test-agent.adcontextprotocol.org/mcp-strict`: report goes from `31 pass / 2 fail / 6 skip` (with vectors 007 and 018 reported as false-failures) to `31 pass / 0 fail / 8 skip`. The two extra skips are correctly classified as capability-profile mismatches.
