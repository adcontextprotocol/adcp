---
---

Fix additional storyboard fixture assumptions surfaced by the Ozone test run:

- `idempotency` and `schema-validation` now declare controller seeding for the `test-product` / `test-pricing` create-media-buy payloads.
- Creative pagination now filters list_creatives requests to seeded fixture IDs so pre-existing creative entries do not change exact count and terminal-page assertions.
