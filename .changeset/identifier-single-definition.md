---
"adcontextprotocol": minor
---

Property and placement identifiers now resolve to one definition. `core/identifier.json` is the single record, and the four inline `identifiers` item copies in `core/property.json`, `core/placement.json`, `core/placement-definition.json`, and `core/canonical-placement.json` now `$ref` it (#8301).

The record now states an explicit `additionalProperties: true` in place of `false`. Under DR-0019 (closed row schemas are a deliberate class), an identifier is neither a Class A nor a Class B schema, so it is opened per DR-0019 and the DR-0009 open default. The change has two effects:

1. **Extra keys are accepted.** Consumers that validated against the closed `core/identifier.json` now accept extra keys in an identifier (for example `{type, value, vlaue}`). DR-0019 asks that a loosening name the unknown-key lint that replaces the closed validation. That lint does not exist in this release, so a misspelled identifier key validates and is ignored.
2. **The hostname rule reaches new sites.** The #8289 `domain` / `subdomain` hostname rule now applies at every site that references `core/identifier.json`, including `adagents.json` `properties[].identifiers` and inline agent properties, `get_products` `placements[].identifiers`, adagents placement definitions, canonical product placements, and the embedded `property` / `properties[]` in registry events. At base these sites did not apply the rule; this extends #8281's scope beyond property-list inputs. The rule first shipped in `v3.3.0-beta.0` and is absent from 3.2.7, so a mixed-case, trailing-dot, or URL-shaped `domain` / `subdomain` value that validated under 3.2.7 or `v3.3.0-beta.0` at these sites is now schema-invalid. It fires only for `type: domain` or `subdomain`.

The loosening also reaches the schemas that already `$ref` `core/identifier.json`, not only the four edited sites: `core/creative-variant.json`, `core/property-delivery-metrics.json`, `core/collection-property-delivery-metrics.json`, `core/installment-property-delivery-metrics.json`, `core/placement-property-delivery-metrics.json`, `core/registry-event.json`, `property/base-property-source.json`, `property/delivery-record.json`, `property/get-property-list-response.json`, `property/property-list-filters.json`, and `property/validation-result.json`. Those sites already applied the hostname rule from #8289, so for them only the open-record change is new.

**Dedupe.** Receivers MUST de-duplicate the effective identifier set by exact (type, value); `placement.json` and `canonical-placement.json` carry the MUST while `placement-definition.json` points to it. Schema `uniqueItems` rejects only entries equal in every member within one array and does not enforce this rule.
