---
"adcontextprotocol": minor
---

Add an optional `opportunity` object to the `get_products` compatibility request, reusing the 3.2 `OpportunityContext` shape from `request_proposals`. Valid with `brief` and `refine` buying modes, rejected with `wholesale`, and limited to `status: "open"`. Sellers that track opportunities associate created proposals with it and preserve the association through refine; it takes precedence over the `ext.adcp.opportunity` bridge.
