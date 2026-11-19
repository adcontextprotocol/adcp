---
"adcontextprotocol": patch
---

State three schema rules directly, with no change to which payloads validate. `core/creative-representation.json` references the creative manifest's shared fields and its canonical-format branch, instead of the whole manifest union minus the named-format branch; the manifest's shared fields move to `definitions/creative-manifest-base`. `core/account-ref.json` states `anyOf` over its two forms, like `core/canonical-account-ref.json`; the forms already exclude each other. The deprecated `list_creative_formats` responses say that a canonical format declaration appears in them only through its `v1_format_ref`.
