---
---

fix(crawler): skip adagents.json properties missing required fields

Malformed `adagents.json` files in the wild ship `properties` entries that omit
`property_type`, `name`, or `identifiers`. The crawler used to forward these
straight to `discovered_properties` and crash mid-batch with either
`property.identifiers is not iterable` or a Postgres `NOT NULL` violation on
`property_type`, taking the rest of the crawl down with them.

The crawler now sanitizes each property before insert: missing required fields
cause that one property to be skipped (with a warning), and a non-array
`identifiers` value is coerced to `[]`. The rest of the manifest still records
normally.
