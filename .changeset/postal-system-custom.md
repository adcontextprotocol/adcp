---
"adcontextprotocol": minor
---

Replace country-fused postal targeting as the preferred shape with country-local postal systems:

- `postal-system` now adds country-local system names such as `zip`, `zip_plus_four`, `outward`, `plz`, and the fallback `postal_code`; the published enum retains existing country-fused values for 3.x compatibility.
- New postal area objects use `{ country, system, values }`.
- Country/system pairs are validated so known countries only accept their registered local systems; unknown countries use `postal_code` or `custom`.
- `get_adcp_capabilities.media_buy.execution.targeting.geo_postal_areas` now prefers an ISO 3166-1 alpha-2 country-keyed map such as `{ "US": ["zip"], "ZA": ["postal_code"] }`.
- During the 3.x migration, sellers SHOULD emit equivalent deprecated aliases such as `us_zip` alongside native country keys where an alias exists. Buyers and SDKs SHOULD normalize both forms.
- Deprecated country-fused aliases remain accepted through legacy branches for SDK backfill and existing integrations.
- Delivery geo rows now require native postal rows to include `country`.

Refs #5383.
