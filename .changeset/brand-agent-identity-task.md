---
"adcontextprotocol": minor
---

Remove brand_agent from brand.json entirely — both the top-level variant and the field on individual brands. Brand identity is public data that belongs in static files. SI agent discovery happens through get_adcp_capabilities and the registry, not through brand.json.
