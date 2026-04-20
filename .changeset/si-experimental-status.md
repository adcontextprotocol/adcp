---
"adcontextprotocol": patch
---

Mark Sponsored Intelligence as experimental in AdCP 3.0 using the canonical [experimental-status](/docs/reference/experimental-status) convention, replacing the prior "pre-release" and "Draft Specification" markers.

Adds `x-status: experimental` to every SI schema (`si-capabilities`, `si-identity`, `si-ui-element`, the four session-lifecycle request/response pairs) and to the `sponsored_intelligence` field on `get_adcp_capabilities`.

Introduces the `sponsored_intelligence.core` feature id in the canonical experimental-surfaces table. Sellers implementing any SI task MUST declare `sponsored_intelligence.core` in `experimental_features` on `get_adcp_capabilities`.

Consolidates status signals across the FAQ, overview, specification, SI Chat Protocol page, task reference pages, What's New, and certification content so SI carries one contract, not three.
