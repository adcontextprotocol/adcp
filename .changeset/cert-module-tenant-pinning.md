---
---

Pin each certification module to the training-agent tenants its lessons exercise. Sage now hands learners deterministic per-tenant URLs (`/signals/mcp` for B3, `/brand/mcp` + `/governance/mcp` for C2, etc.) instead of the legacy single-URL alias that pre-dated the multi-tenant migration in #3713.

Schema: new `tenant_ids TEXT[]` column on `certification_modules`, ordered (index 0 = primary, the URL Sage emits first). NULL means "no pinning — fall back to the discovery extension on adagents.json" (today's behavior; safe default for modules we haven't classified yet). Migration 464 backfills all 20 seeded modules.

Plumbing: new `tenantUrlsForModule()` helper in `server/src/training-agent/config.ts` resolves `tenant_ids` to per-tenant URLs at the prompt boundary; `formatTenantBlock()` in `certification-tools.ts` collapses single-tenant modules to a one-liner and emits a primary + sibling list for multi-tenant modules. Three injection sites updated: `buildCertificationContext` (active-modules union), `start_certification_module`, and `get_certification_module`.

Closes the wrong-tenant footgun for cert work: a learner working on a signals module no longer gets pointed at `/sales/mcp`, finds `get_signals` missing, and hits `Unknown tool`. Lays the groundwork for the persona harness in #3712 — assertions become "for module M, did Sage steer the persona to a tenant in `M.tenant_ids[]`, primary first?" instead of "did the LLM correctly infer it from the discovery extension?"
