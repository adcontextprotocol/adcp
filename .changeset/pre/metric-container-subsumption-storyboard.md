---
"adcontextprotocol": patch
---

Add a compliance storyboard (`media_buy_seller/metric_container_subsumption`) pinning independent implementations to the container-subsumption rule in `enums/available-metric.json`: a container token (e.g. `viewability`) satisfies `required_metrics` filtering and `requested_metrics` selection for its leaf identities (e.g. `viewable_rate`), leaf selection resolves to the canonical carrier object rather than a flat duplicate, and a leaf never implies a sibling leaf. The training agent's reference seller gains the missing `required_metrics` filter on `get_products`, evaluated through the same subsumption-aware availability check its `requested_metrics` narrowing already uses, closing the divergence hazard flagged in #6785.
