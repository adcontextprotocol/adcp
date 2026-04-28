---
---

Add `grade_agent_signing` and `diagnose_agent_auth` tools to Addie's `agent_testing` capability set.

Both wrap the same conformance graders that power `npx @adcp/client grade request-signing` and `npx @adcp/client diagnose-auth`, so Addie can run RFC 9421 signing grades and OAuth handshake diagnoses interactively in Slack and web threads instead of telling users to install the CLI locally.

`diagnose_agent_auth` calls `runAuthDiagnosis` from `@adcp/client/auth` in-process. `grade_agent_signing` shells out to the published `@adcp/client` CLI's `grade request-signing --json` because `gradeRequestSigning` isn't yet on the package's public export surface — follow-up tracks promoting it so the tool can move in-process.

Live-side-effect vectors (real `create_media_buy`, replay-cap flood) are skipped by default. Callers must pass `allow_live_side_effects: true` to run them and should only do so against sandbox endpoints.

Closes #3371.
