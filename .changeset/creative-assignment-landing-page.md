---
"adcontextprotocol": minor
---

Add optional assignment-scoped `landing_page_url` in AdCP 3.3 to package creative assignments and `sync_creatives` assignments and assign operations. The override changes the destination for one creative on one package without changing the library creative or its approval. Sellers must serve it or reject the assignment, review destinations at assignment scope, and return the actual serving destination from `list_creatives` and `get_media_buys`. The new `creative.supports_assignment_landing_page` capability defaults to false and requires a creative library; unsupported agents reject the field with `UNSUPPORTED_FEATURE`. After an assignment merge, the buyer creative's effective package destination applies.
