---
"adcontextprotocol": minor
---

Add get_capabilities task for expanded capability discovery

Introduces `get_capabilities` task replacing `list_authorized_properties` with expanded capability declaration:

**Protocol section:**
- `adcp_major_versions` - Declare supported AdCP major versions for compatibility
- `features` - Optional protocol features (inline_creative_management, property_list_filtering, content_standards)

**Execution section:**
- `axe_integrations` - Agentic ad exchange URLs this seller can execute through
- `creative_specs` - VAST/MRAID version support
- `targeting` - Geo targeting capabilities with granular system support

**Geo targeting:**
- Countries (ISO 3166-1 alpha-2)
- Regions (ISO 3166-2)
- Metros with named systems (nielsen_dma, uk_itl1, uk_itl2, eurostat_nuts2)
- Postal areas with named systems encoding country and precision (us_zip, gb_outward, ca_fsa, etc.)

**Product filters:**
- Added regions, metros, postal_areas filters
- Added required_axe_integrations, required_features capability filters

**Capability contract:** If a capability is declared, the seller MUST honor it.
