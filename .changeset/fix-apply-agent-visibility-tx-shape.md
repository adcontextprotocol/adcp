---
---

Close #2825: move the brand.json manifest write in `applyAgentVisibility` outside the profile transaction. If the manifest write was inside the tx and succeeded while the commit later failed, we'd orphan a manifest entry pointing at an agent whose `visibility: 'public'` never committed — the exact drift the `/check` endpoint was built to detect. Mirrors the same pattern that landed for `demotePublicAgentsOnTierDowngrade` in #2822: stage the manifest op inside the locked tx, commit the JSONB, then execute the manifest write outside. A failed manifest write after commit logs a structured `brand_json_drift` event so the `/check` reconciler can surface it, and the profile JSONB stays authoritative.

Drive-by: fixes the pre-existing integration-test signature mismatch for `demotePublicAgentsOnTierDowngrade` (argument list updated in #2822 but `tests/integration/agent-visibility-e2e.test.ts` wasn't touched — typecheck excludes `tests/`).

New integration test pins the invariant: with `brandDb.updateManifestAgents` forced to throw, the POST `/publish` response is still 200, the manifest write was attempted (not skipped), and the profile JSONB reflects the new `visibility: 'public'`.
