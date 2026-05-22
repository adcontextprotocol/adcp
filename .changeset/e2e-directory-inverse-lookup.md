---
"adcontextprotocol": patch
---

feat(scripts): exercise the AAO directory inverse-lookup in the agent-resolution e2e script.

`scripts/e2e-resolve-training-agent.ts` now optionally appends a directory inverse-lookup after the 8-step forward chain. Given the resolved agent URL, the script calls `fetchAgentAuthorizationsFromDirectory` (shipped in `@adcp/sdk@7.10.0`) against the AAO's `GET /api/v1/agents/{agent_url}/publishers` endpoint and prints the publishers whose `adagents.json` authorize the agent.

- HTTP mode: defaults the directory URL to `<base-url>/api` (where the registry router is mounted in `server/src/http.ts`). Pass `--directory <url>` to point at a different directory, or `--directory none` to skip.
- In-process mode: skipped (the inline Express app doesn't mount the AAO routes, which require database access).

Pairs PR #4836 (server endpoint) with the SDK's consumer-side wrapper, giving a runnable demo of the full directory chain. Directory failures are caught and reported but don't fail the script — the forward chain is the primary contract, the inverse lookup is an additive demo.
