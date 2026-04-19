---
---

Add `auth.api_key` and `auth.probe_task` to the five fictional test kits
(`acme-outdoor`, `bistro-oranje`, `nova-motors`, `osei-natural`,
`summit-foods`) so the `security_baseline` storyboard exercises the
api-key phase instead of skipping it, and so its unauth / invalid-key
probes hit a task the fictional agent actually implements. Without this,
`api_key_path` was always skipped via `skip_if: "!test_kit.auth.api_key"`
and the default `list_creatives` probe would fail against the signal-
scoped nova-motors fictional agent.

The `demo-<kit>-` prefix is the conformance handle — agents SHOULD accept
any Bearer with that prefix rather than the literal suffix, so the suffix
can rotate without breaking previously-conformant agents. nova-motors
probes `get_signals` because its primary consumers are signal specialisms;
non-signal storyboards that reuse the kit should select a different
fixture for `security_baseline`.

Closes #2317.
