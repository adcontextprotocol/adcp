---
"adcontextprotocol": major
---

Delete brand-manifest.json. The brand object in brand.json is now the single
canonical brand definition. Task schemas reference brands by domain + brand_id
instead of passing inline manifests. Brand data is always resolved from
brand.json or the registry.
