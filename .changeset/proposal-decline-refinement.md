---
"adcontextprotocol": minor
---

Add proposal opportunity and decline feedback to the media-buy flow. Buyers can now provide optional buyer-reported `opportunity` context across `get_products` and `create_media_buy` calls, while proposal refine entries support `action: "decline"` with a required `proposal_version` and reason taxonomy. `get_products` also supports `buying_mode: "open"` to reload unresolved products/proposals already associated with the caller/account/opportunity without adding a new task or response grouping object. Versioned proposals carry `proposal_version` through `create_media_buy` so sellers can verify the accepted offer version and reject execution of previously declined proposal versions. Opportunity close reasons distinguish `accepted_with_seller` from loss outcomes, and proposal-capable sellers get compliance coverage for decline acknowledgement, duplicate declines, and create rejection after decline.
