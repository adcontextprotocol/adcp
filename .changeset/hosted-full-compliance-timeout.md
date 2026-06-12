---
"adcontextprotocol": patch
---

fix(compliance): raise hosted full-assessment comply() budget to 600s

@adcp/sdk 9.0.0-beta.28 applies the per-call `--timeout` (default 120s) as the wall-clock budget for the *entire* pre-flight `comply()` assessment. A full capability-rich assessment legitimately runs ~117s, so the 120s ceiling graded the most compliant agents "unreachable" with 0 steps and let registry cards go stale silently.

Adds `HOSTED_FULL_COMPLIANCE_TIMEOUT_MS = 600_000` and threads it through every hosted full-suite `comply()` call site — the compliance heartbeat job, the owner/admin registry-refresh endpoint, the `evaluate_agent_quality` member tool, and the heartbeat-mirroring diagnostic script — replacing the prior 60s/90s/SDK-default values.

The heartbeat in-progress lock TTL now tracks the worst-case serial batch (batch size × budget) so an agent late in the loop isn't re-picked by an overlapping run.

This is a hosted-side mitigation; it does not change the SDK's CLI default-timeout behavior (tracked upstream in adcontextprotocol/adcp-client#2221). Revisit the 600s budget when the SDK restores per-call timeout semantics.
