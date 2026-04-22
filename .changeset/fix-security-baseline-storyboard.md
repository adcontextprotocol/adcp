---
---

Fix the `security_baseline` storyboard against the embedded training agent (closes #2841).

- Remove the RFC 9728 PRM stub from `run-storyboards.ts` / `run-one-storyboard.ts`: the training agent is API-key-only, so advertising an unsupported OAuth issuer triggered the exact failure the storyboard was written to catch. The API-key path alone now carries `auth_mechanism_verified`.
- Thread the declared test-kit `auth.api_key` / `auth.probe_task` through to `runStoryboard()` so `api_key_path` executes instead of being silently skipped by `skip_if: "!test_kit.auth.api_key"`.
- Accept the documented `demo-<kit>-v<n>` conformance handle on the training-agent bearer authenticator so storyboard-declared API keys actually authenticate.
- Emit `structuredContent` on tool success so the storyboard runner's `rawMcpProbe` can resolve JSON-pointer paths (`context.correlation_id`); keep `content: []` empty to avoid the SDK unwrapper's `_message` injection failing strict per-task response schemas.
- Fix `summarize()` in `run-storyboards.ts` to read `step_id` instead of `id`, so failure output names the actual failing step instead of `(unknown step)`.
