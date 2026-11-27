---
"adcontextprotocol": patch
---

Docs: the 3.3 release notes, What's new, and the 3.2 to 3.3 migration guide describe the campaign-governance changes that 3.3 already carries (adcp#9006 and the aggregation key from adcp#8931). The migration guide gains upgrade checklist steps for governance agents, buyers and sellers, and an experimental surface notice with a before-and-after table: a failed `approved_sellers` or `delegations` evaluation is a `denied` verdict in every governance mode, a caller that cannot access a plan gets `PLAN_NOT_FOUND`, a `sync_plans` that cuts the budget below committed spend is rejected, `plan_id` is unique per owner principal, and aggregated spend is keyed on `(owner_principal, seller_agent)`. The experimental table in the release notes no longer describes the `governance.campaign` changes as additive only. No schema, specification or compliance file changes.
