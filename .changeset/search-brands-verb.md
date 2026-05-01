---
"adcontextprotocol": minor
---

Add `search_brands` task to the brand protocol.

Provides a natural-language brand discovery verb for IP desks that need to find brands on an agent's roster before they have a known `brand_id`. Returns lightweight brand stubs (public identity tier) that feed directly into `get_brand_identity` or `get_rights` without an extra identity-resolution round-trip.

New schemas (experimental): `search-brands-request.json`, `search-brands-response.json`. New task type `search_brands` added to stable `task-type.json` enum.

Closes #3480.
