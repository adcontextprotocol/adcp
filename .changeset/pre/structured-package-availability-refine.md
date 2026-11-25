---
"adcontextprotocol": minor
---

Add optional structured package inputs to product-scoped get_products refinement for exact pre-booking availability checks. Share create-package field types and validation, require explicit per-entry forecast outcomes with configured product mapping and resolved flight timestamps, and define independent, read-only forecasting without booking or reserving inventory.

Compact media-buy MCP schema references using their embedded canonical resource IDs, preserving validation while keeping the shared package graph within the existing projection size budget.

Withdrawn before 3.3.0 GA (#8758): `refine[].package`, `media-buy/package-forecast-input.json`, and `refinement_applied[]` `result_product_id`, `resolved_start_time` and `resolved_end_time` left `get_products` after beta.5. The exact-package forecast has no 3.3 task.
