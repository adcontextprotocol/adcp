---
"adcontextprotocol": minor
---

Add operator-facing registry lifecycle guide and certification module resource.

Adds `docs/registry/maintaining-your-agent.mdx` — a new Mintlify page covering the full operator lifecycle for registered agents: the registration recap, how the AAO Verified heartbeat works (~1h cadence, storyboard suite, Spec vs Sandbox axes), dashboard status indicators (Active / Degraded / Revoked / Recovery) with per-status operator actions, how to manually trigger a re-probe (`POST /api/registry/crawl-request` and the dashboard Refresh button, both registry-metadata refreshes distinct from a compliance heartbeat re-run), and how to read a comply report (overall verdict, per-storyboard verdicts, debugging workflow).

Vocabulary follows the AAO Verified spec: uses "Degraded" (not "silent", "stale", or "offline") for the first-failure state, and correctly attributes the 48-hour grace period to continuous storyboard failure from the initial missed probe.

Note on manual compliance re-runs: manually triggering a full storyboard re-run outside the heartbeat schedule is not currently available via dashboard or API (#4253). Operators should use `@adcp/sdk/testing` locally to reproduce failures before the next scheduled heartbeat.

Adds the page to the Registry API navigation group in `docs.json` (both tab contexts). Adds a `R1` entry in `MODULE_RESOURCES` in `server/src/addie/mcp/certification-tools.ts` so Sage can surface registry lifecycle reading material during certification sessions.

Closes #4434.
