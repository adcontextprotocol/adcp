---
"adcontextprotocol": minor
---

Add structured DOOH/OOH location fields: `dooh_placement_attributes.location` (`lat`/`lon`/`address`) on `placement.json`, `placement-definition.json`, and `canonical-placement.json` for concrete single-screen placements, and a new `dooh_inventory_summary.venue_counts[]` on `product.json`/`canonical-product.json` for aggregate network geography. Closes #5538. All fields are optional and additive; location is disclosure metadata, not placement identity.
