---
"adcontextprotocol": patch
---

Add `server/src/scripts/reconcile-brand-domain-www-mismatch.ts` — one-shot reconciliation for the three orgs identified by the #4448 audit (Affinity Answers, BidMachine, Scope3). Per affected org, copies `brand_manifest.agents` from `www.<domain>` into `<domain>` (deduped on agent url), marks the www brand row `manifest_orphaned=true`, and inserts a `brand_domain_aliases` row routing `www.<domain>` → `<domain>` (Scope3 already has the alias and an empty www stub — only the orphan step runs there). Idempotent; dry-run by default; `--apply` to persist. Resolves the publish-path drift introduced when Stage 2 of #4159 (`5163d21425`) moved brand-domain authority to `organization_domains.is_primary` without backfilling orgs whose prior brand curation lived on the www variant.
