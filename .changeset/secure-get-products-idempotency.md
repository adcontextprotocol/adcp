---
"adcontextprotocol": minor
---

Add the compact AdCP 3.2 product lifecycle: `list_products`, `request_proposals`, `refine_proposals`, `finalize_proposals`, and `decline_proposals`. The task-specific contracts separate offer discovery from proposal creation, immutable refinement, atomic commitment, terminal decline, and purchase while retaining `get_products` as a key-optional compatibility facade throughout 3.x. A shared opportunity reference connects planning-cycle context without duplicating proposal version identity.
