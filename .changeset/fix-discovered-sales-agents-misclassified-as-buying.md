---
---

Fix discovered sales agents being registered as `type: "buying"` instead of `type: "sales"`.

The capability-discovery code was inferring `'buying'` from `SALES_TOOLS` (`get_products`, `create_media_buy`, `list_authorized_properties`) — semantically backwards: these tools are exposed by **sell-side** agents authorized to sell on behalf of publishers. Three inference sites are corrected (`server/src/capabilities.ts` × 2, `server/src/db/agent-context-db.ts`), and migration `453_fix_misclassified_sales_agents.sql` flips existing `discovered_agents` rows from `'buying'` → `'sales'` (the crawler only re-infers `'unknown'` rows, so the misclassification was sticky without a backfill).

Closes #3495.
