---
"adcontextprotocol": minor
---

Add the projection-only `products_available` outcome for valid AdCP 2.5, 3.0,
and 3.1 products-only brief results. The response now provides either a real
seller-fenced `listed_purchase` continuation or an explicitly lossy,
fail-closed `legacy_create` continuation without fabricating proposals, terms
digests, or feed versions. AdCP 2.5 continuations additionally disclose the
absence of a mutation replay guarantee. Document transaction-boundary
differences between the established and compact media-buy lifecycles, and route
supported MediaBuy name actions through compact control.
