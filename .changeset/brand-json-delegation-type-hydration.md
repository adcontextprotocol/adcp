---
---

Adds `delegation_type` as a structured field on brand.json-hydrated publisher
properties in `/api/registry/publisher`. The field mirrors adagents.json's
`delegation_type` enum (`direct`/`delegated`/`ad_network`) so agentic buyers
can filter by delegation relationship without parsing `relationship:` tag prefixes.

`owned` properties have no `delegation_type` — ownership has no adagents.json
counterpart for bilateral verification and is implicit from the publisher
declaring the property in their own brand.json.

The `relationship:` tag is retained for backward compat and marked deprecated
in the `PublisherPropertySchema` OpenAPI description.
