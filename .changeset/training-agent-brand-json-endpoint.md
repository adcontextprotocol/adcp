---
---

feat(training-agent): serve schema-conformant `/.well-known/brand.json`

The training agent now serves a brand.json discovery document conformant
with `static/schemas/source/brand.json` oneOf[3] (house portfolio
variant). Declares AAO as the house operating the training agent and
lists each tenant's MCP endpoint as a typed `brand_agent_entry` with a
`jwks_uri` pointing at the shared `/.well-known/jwks.json`.

Single-tier (no `brand_refs[]`, no `house_domain`). Per-publisher /
multi-tier fixtures (Sportshaus / StreamHaus / Northwind from the
verification walkthrough) come in a follow-up PR. Unblocks step 2
("Read the seller's brand.json") of the seller-verification walkthrough
being demoable against the training agent.

Replaces an earlier malformed handler in `tenants/router.ts` that
returned `{ jwks: getAggregatedPublicJwks() }` under the brand.json path
— that endpoint pre-dated the brand-protocol schema and was used only
for SDK-validator debug introspection (`autoValidate: false`).
`getAggregatedPublicJwks()` remains exported for direct callers
(`training-agent-governance-signing.test.ts`); buyer-side fetchers walk
the chain via `agents[].jwks_uri` pointers.
