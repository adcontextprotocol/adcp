---
---

feat(training-agent): seller-verification walkthrough fixtures

Adds schema-conformant brand.json / adagents.json fixtures simulating the
multi-tier chain documented at `docs/verification/overview`:

- **Northwind Media** — independent agency (standalone canonical brand doc, names a signing JWKS)
- **StreamHaus** — sub-brand publisher (canonical brand doc with `house_domain` pointing at Sportshaus Holdings, `keller_type: "endorsed"`)
- **StreamHaus's adagents.json** — authorizes Northwind under `delegation_type: "delegated"`, names the signing-key `kid` inline
- **Sportshaus Holdings** — parent house (house portfolio variant, `brand_refs[]` reciprocates StreamHaus → bilateral mutual assertion closes)

Fixtures live in `server/src/training-agent/fixtures/verification-walkthrough/` as schema-conformant JSON. The TypeScript module exports a typed `WALKTHROUGH_FIXTURES` map for in-process consumers (storyboards, conformance tests). Each document is also served over HTTP at `/fixtures/walkthrough/<role>/.well-known/<doc>` so a buyer agent pointed at the training agent's host can fetch the chain end-to-end against simulated publisher / sub-brand / parent-house surfaces.

Test (`training-agent-verification-walkthrough-fixtures.test.ts`) validates each document against the canonical schema with Ajv and asserts the bilateral parent/sub-brand assertion closes end-to-end (`streamhaus.house_domain ↔ sportshaus.brand_refs[].domain`).

Step 1 of the walkthrough (RFC 9421 signature verification) is blocked on the `signResponse` SDK helper tracked under [adcp-client#1822](https://github.com/adcontextprotocol/adcp-client/issues/1822); steps 2/3/4 (brand.json, adagents.json, parent-house) are now fully demoable.
