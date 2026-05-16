---
---

`/api/registry/publisher` now falls back to the publisher's brand.json when
the federated index has no properties for the domain. brand.json
`properties[]` (top-level or `brands[].properties[]`) is mapped into the
publisher payload and tagged with `source: "brand_json"` so callers can tell
where each property came from. The same payload now also tags
federated-index properties with `source: "discovered"`.

Eliminates the "0 properties" first-touch experience for publishers who
already declared their inventory in brand.json.
