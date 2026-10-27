---
"adcontextprotocol": patch
---

Reopen the 3.2 proposal-flow schemas that were closed against DR-0019, as correction (a) recorded in DR-0036.

3.2 published the proposal-flow task roots and containers with `additionalProperties: false`. DR-0019 keeps request roots, response roots, and container objects open. These schemas now set `additionalProperties: true` at the listed locations:

- the request roots of `list_products`, `request_proposals`, `refine_proposals`, `buy_products`, `accept_proposal`, `decline_proposals`, and `control_media_buy`;
- the response roots of `list_products`, `request_proposals`, `refine_proposals`, and `decline_proposals`, and the `refine_proposals` result row;
- the three branches of `media-buy-commitment-response.json` (`buy_products` and `accept_proposal`) and of `control-media-buy-response.json`;
- `core/canonical-proposal.json`, `core/canonical-product.json`, `media-buy/product-discovery-criteria.json`, `media-buy/proposal-refinement.json`, `media-buy/package-control.json`, and `core/opportunity-context.json`.

Every payload that was valid stays valid. The `adcp_version` echo now validates on the `control_media_buy`, `decline_proposals`, `buy_products`, and `accept_proposal` responses (#8518). A strict 3.2 validator still rejects new fields on these schemas, so senders include 3.3 fields only when the negotiated release is 3.3 or later. `commercial-terms.json` and the purchases inside it stay closed.
