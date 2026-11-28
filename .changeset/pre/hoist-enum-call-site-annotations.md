---
"adcontextprotocol": patch
---

Bundled schemas (`/schemas/{version}/bundled/`) keep each field's own annotations when the build hoists a repeated enum to root `$defs`. The hoisted entry holds only what every occurrence shares, and a field's own `description`, `default`, `deprecated`, `enumDescriptions` or `x-*` stays beside its `$ref`. Before, every occurrence took the annotations of the first one the build met, so a field could show another field's description or gain a `default` it does not have. Source schemas and validation are unchanged.
