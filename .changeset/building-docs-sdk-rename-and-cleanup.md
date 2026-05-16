---
---

docs(building): rename `@adcp/client` → `@adcp/sdk`, fix API surface, and reframe SDK coverage

- Bulk-rename the npm package across all docs (244 occurrences across 46 files) — `@adcp/client@5.x` is on security-only support; `@adcp/sdk@6.9.0` is the production GA.
- Rewrite caller code samples to match 6.x: `ADCPClient` is gone, replaced by `createSingleAgentClient` / `ADCPMultiAgentClient`. New constructor takes `{id, name, agent_uri, protocol, auth_token}`.
- Fix Python samples: `ADCPClient(agent_url=…)` was never the API. Now uses `ADCPClient(AgentConfig(id, agent_uri, protocol))` and `await client.get_products(GetProductsRequest(brief=…))`.
- Replace fabricated `@adcp/sdk/webhooks` import with a pointer to the real `createWebhookVerifier` in `@adcp/sdk/signing/server`, and refresh the package-exports table on `choose-your-sdk` to match the actual subpath surface.
- Fix CLI invocations: `npx @adcp/sdk@latest <protocol> <agent-url> <tool> '<json>'` is the real shape (positional, not `--agent` flag).
- Reframe the SDK coverage table on `choose-your-sdk` and `sdk-stack` from "5.13.0 floor / 6.9.0 GA" (which conflated minimum-3.0-conformant with current GA) to "Production GA / Beta-or-dev" columns. TS GA `6.9.0`, Python GA `3.x` with `4.x` in beta, Go in dev.
- Lift the layer diagram from `sdk-stack` onto the `/docs/building/` landing in place of the "five layers, in one paragraph" prose, and add a "Talk to Sage" entry-point link in Going deeper.
- Drop the stale `Remove after 2026-04-25` callout (today is past that date).
- Fix `get-test-ready` pinning users at `^5.13.0` (security-only line) — now installs latest.
- Fix `migrate-from-hand-rolled` server-side `supported_versions` example contradicting the version-adaptation rule (release-precision strings only on the server).
- Fix Prebid SalesAgent repo link (`prebid/prebid-server` → `prebid/salesagent`).
- Small fixes: `authToken` → `auth_token` on `version-adaptation`, link the unlinked Prebid SalesAgent mention on the landing.
