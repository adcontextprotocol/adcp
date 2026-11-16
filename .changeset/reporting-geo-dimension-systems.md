---
"adcontextprotocol": minor
---

Experimental reporting subscriptions (`media_buy.reporting_subscriptions`) now break delivery down by geography the same way a delivery report does. The standard reporting dimension vocabulary gains `postal_area`. A new `dimension_systems` object names the system behind a `metro` or `postal_area` breakdown: `metro` takes a metro system such as `nielsen_dma`, and `postal_area` takes a list of `{ country, system }`.

- **Offerings.** An offering whose `standard_dimensions` include `metro` or `postal_area` MUST publish `dimension_systems` for each, so a metro code such as `501` is never ambiguous.
- **Selectors.** A subscription selector may set `dimension_systems` to match only offerings in those systems. Without it, any system matches, as before.
- **Report definitions.** A `contract_version` `1.2` report definition names each geography dimension with its standard name (`country`, `region`, `metro`, `postal_area`) and fills it with codes, never display names: ISO 3166-1, ISO 3166-2, or a code in the offering's metro or postal system. These are the values `geo_code` carries in `by_geo` delivery rows, so a breakdown reads the same in `get_media_buy_delivery` and in a reporting feed. A display name may ride beside them as a non-authoritative `geo_name` dimension, and a native geography dimension that breaks the rule is unmapped.

Updated: `sync_principal` (selector), `get_reporting_status` (report definition versions), and the reporting-subscription coverage test vectors (three cases).
