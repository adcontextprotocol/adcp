---
"adcontextprotocol": minor
---

Add the AdCP 3.2 `list_products`, `recommend_products`, `refine_proposal`, and `finalize_proposals` tools. The split tools give reads, recommendations, refinements, and commits explicit idempotency contracts while retaining `get_products` as a key-optional compatibility facade throughout 3.x. Keyed retries are equivalent across legacy and split names.
