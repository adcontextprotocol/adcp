---
"adcontextprotocol": patch
---

Reopen the 3.2 proposal-flow schemas that were closed against DR-0019, as a correction recorded in DR-0036 (#8501). DR-0019 keeps request roots, response roots, and container objects open. These schemas now set `additionalProperties: true` at 24 locations:

- the request roots of `list_products`, `request_proposals`, `refine_proposals`, `buy_products`, `accept_proposal`, `decline_proposals`, and `control_media_buy`;
- the response roots of `list_products`, `request_proposals`, `refine_proposals`, and `decline_proposals`, and the `refine_proposals` result row;
- the three branches of `media-buy-commitment-response.json` (`buy_products` and `accept_proposal`) and of `control-media-buy-response.json`;
- `core/canonical-proposal.json`, `core/canonical-product.json`, `media-buy/product-discovery-criteria.json`, `media-buy/proposal-refinement.json`, `media-buy/package-control.json`, and `core/opportunity-context.json`.

Every payload that was valid stays valid. Two rejections that closure provided are now stated by name: `core/canonical-product.json` forbids the legacy `format_ids`, and the `request_proposals` response forbids a root `feed_version` or `pricing_version`. This patch adds no fields. `commercial-terms.json` and the purchases inside it stay closed.
