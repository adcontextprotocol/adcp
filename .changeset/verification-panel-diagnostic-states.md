---
---

dashboard(verification-panel): scope the empty-state hint to the actual situation and surface declared specialisms inline. The per-agent compliance card now answers "why hasn't my badge issued?" without a context switch — five distinct branches (no auth, opted out, passing-no-specialisms-declared, passing-pending-heartbeat, storyboards-failing, unknown) each carry their own diagnostic copy. The biggest silent failure mode (agent passes storyboards but declares zero specialisms in `get_adcp_capabilities`) gets a dedicated message pointing at the docs.

Auth-broken cases short-circuit: if there are no creds, the cached status is stale and the only useful next step is to fix auth — so `!hasAuth` overrides the cached status. The decision matrix is extracted to `pickVerificationHint()` in `services/verification-hint.ts` with a vitest table covering all five enum statuses plus null.

Backend: `GET /api/registry/agents/:url/compliance` now returns `declared_specialisms[]` from the latest run's `agent_profile_json.specialisms`. The dashboard renders these as `<code>` chips in the panel header so a developer can verify what AAO sees without re-running compliance. Malformed payloads (specialisms non-array) are logged at debug and treated as empty.
