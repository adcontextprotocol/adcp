---
"adcontextprotocol": patch
---

Add `server/src/scripts/audit-brand-domain-www-mismatch.ts` — dry-run audit identifying orgs whose past `brand_revisions` were written to a different brand domain than their current `organization_domains.is_primary=true` row (most commonly `www.<domain>` vs `<domain>`). Surfaces the blast radius for issue #4448 (Stage 2 #4159 drift), which manifests as publish-path manifest updates landing on a brand row the user has not previously curated. Read-only; no schema changes; feeds a follow-up backfill decision.
