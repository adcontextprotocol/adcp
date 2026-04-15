---
"adcontextprotocol": major
---

Revert geo capability flattening from #2143. Restore `geo_countries`, `geo_regions` (booleans) and `geo_metros`, `geo_postal_areas` (typed objects with `additionalProperties: false`) as primary geo capability fields. Remove `supported_geo_levels`, `supported_metro_systems`, `supported_postal_systems` arrays. Typed objects provide better static type safety and match what beta/RC users have already implemented against.
