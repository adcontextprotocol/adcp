---
"adcontextprotocol": minor
---

Add cursor pagination for truncated `get_media_buy_delivery` breakdowns on the bounded-enum dimensions: `device_type`, `device_platform`, `audience`, and `placement`. Previously `by_<dim>_truncated: true` was a retrieval dead end — there was no protocol-defined way to fetch the dropped rows. Requests can now set `reporting_dimensions.<dim>.cursor` (reusing the response's new `by_<dim>_pagination` field, itself the existing `pagination-response.json` shape already used by `get_products`) to page through the rest of a truncated breakdown. `geo` is deliberately excluded — at `postal_area` granularity it can reach tens of thousands of rows, closer to a bulk-export shape than per-package cursor pagination, and is deferred to the bulk-export/security work tracked in #5669/#5666. Closes #5671.
