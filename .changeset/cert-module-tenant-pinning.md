---
---

Pin certification modules to the training-agent tenants their lessons exercise. Sage now hands learners deterministic per-tenant URLs (`/signals/mcp` for S3, `/governance/mcp` for S4, `[brand, governance]` for C2, etc.) instead of the legacy `/mcp` monolith alias that pre-dated the multi-tenant migration in #3713.

**Schema**: new `tenant_ids TEXT[]` column on `certification_modules`. Order is significant — index 0 is primary, the URL Sage emits first. NULL means "no pinning — fall back to legacy `/mcp`" (today's behavior; safe default).

**Backfill** (migration 464, idempotent via `WHERE tenant_ids IS NULL`):

- 17 modules pinned to their canonical tenant(s).
- 3 modules (A3 tour, C3 creative+SI, S5 SI capstone) intentionally left NULL — their lessons exercise `si_*` tools that no per-specialism tenant currently serves. Pinning them to a sibling would ship a confidently-wrong URL into Sage's prompt; staying on the legacy alias preserves today's behavior. Tracked as #3940 (add an `si` tenant + repin).

**Plumbing**:

- `tenantUrlsForModule()` in `server/src/training-agent/config.ts` resolves ids → URLs at the prompt boundary.
- `formatTenantBlock()` in `certification-tools.ts` emits a one-liner for single-tenant modules and a primary + internal sibling map for multi-tenant. The multi-tenant block is tagged "Internal — do not narrate to the learner" with an explicit error-driven trigger ("on `unknown tool` error → GET `/.well-known/adagents.json` → switch + retry") so Sage doesn't paraphrase URL noise into the learner conversation.
- Three injection sites updated: `buildCertificationContext` (caches the active-modules fetch + reuses it in the per-module loop, normalizes module ids once), `start_certification_module`, `get_certification_module`.

Reviewed by code-reviewer, security-reviewer, adtech-product-expert, education-expert, and prompt-engineer. Pre-existing SI/curriculum gap surfaced by the review and tracked as #3940. Lays groundwork for the persona harness in #3712 — assertions become "for module M, did Sage steer the persona to a tenant in `M.tenant_ids[]`?" rather than "did the LLM correctly infer it?".
