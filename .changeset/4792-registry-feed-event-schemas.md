---
"adcontextprotocol": minor
---

Add published registry change-feed schemas for `/api/registry/feed`.

The new `core/registry-feed-response.json` wrapper references `core/registry-event.json`, which now validates the current registry event vocabulary across property, agent, publisher, and authorization changes. Registry docs and specs now cite the schemas and align examples with the implemented cursor and filter contract.
