---
"adcontextprotocol": minor
---

Add the compact AdCP 3.2 product lifecycle: `list_products`, `request_proposals`, `refine_proposals`, and `decline_proposals`. The task-specific contracts separate offer discovery from executable proposal creation, immutable refinement, terminal decline, and purchase while retaining `get_products` as a key-optional compatibility facade throughout 3.x. A shared opportunity reference connects planning-cycle context without duplicating proposal version identity. Publish machine-readable SDK fallback grades and task-result schema resolution, plus an MCP production profile that filters out compliance-only and deprecated tools and removes presentation annotations without changing validation semantics.
