---
---

Fix discovered sales agents being registered as `type: "buying"` instead of `type: "sales"`.

The capability-discovery code was inferring `'buying'` from `SALES_TOOLS` (`get_products`, `create_media_buy`, `list_authorized_properties`) — semantically backwards: these tools are exposed by **sell-side** agents authorized to sell on behalf of publishers. Three inference sites are corrected (`server/src/capabilities.ts` × 2, `server/src/db/agent-context-db.ts`), and migration `454_fix_misclassified_sales_agents.sql` flips existing `'buying'` → `'sales'` rows in both `discovered_agents.agent_type` (the crawler only re-infers `'unknown'` rows, so the misclassification was sticky) AND `agent_capabilities_snapshot.inferred_type` (read by `registry-api.ts` and by PR #3498's prevention layer — stale rows there would silently override a correctly-supplied `'sales'` back to `'buying'`).

Closes #3495.
