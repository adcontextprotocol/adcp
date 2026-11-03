---
"adcontextprotocol": patch
---

Fix the `get_products_pagination_integrity` storyboard fixtures on 3.1.x: both seeded products' `publisher_properties` entries now declare `selection_type: "all"`, matching main and 3.2. `core/publisher-property-selector.json` is a discriminated `oneOf` on `selection_type` and every branch requires it, so an entry naming only `publisher_domain` matched no branch — a seller that echoed the seeded product verbatim failed the storyboard's own response-schema validation. Refs #8646.
