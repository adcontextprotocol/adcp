---
"adcontextprotocol": minor
---

Property and placement identifiers now resolve to one definition. `core/identifier.json` is the single record, and the four inline `identifiers` item copies in `core/property.json`, `core/placement.json`, `core/placement-definition.json`, and `core/canonical-placement.json` now `$ref` it (#8301).

- **Open record.** `core/identifier.json` now sets `additionalProperties: true` instead of `false` (DR-0019: an identifier is neither a Class A nor a Class B schema, so it is opened). 3.0 published the record closed, so DR-0036 governs: a non-breaking loosening that grants no additions within 3.x (validators of earlier releases still reject a new identifier property), and not one of its recorded corrections. Extra keys are accepted at every site that references it, so a misspelled key such as `vlaue` validates and is ignored. The unknown-key lint DR-0019 asks for does not exist in this release, so that precondition is unmet and the opening needs explicit working-group ratification.
- **Hostname rule reaches new sites.** The #8289 `domain` / `subdomain` hostname rule now applies at `adagents.json`, `get_products` placements, placement definitions, canonical product placements, and registry events. A mixed-case, trailing-dot, or URL-shaped value that validated under 3.2.7 or `v3.3.0-beta.0` at these sites is now schema-invalid. The other schemas that already referenced `core/identifier.json` get only the open-record change; the [3.2 to 3.3 migration guide](/docs/reference/migration/3-2-to-3-3) lists them.
- **Dedupe.** Receivers MUST de-duplicate the effective identifier set by exact (type, value). Schema `uniqueItems` does not enforce this, because entries that differ only in an extra key are no longer equal.
