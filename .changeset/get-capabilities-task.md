---
"adcontextprotocol": minor
---

Add protocol-level get_adcp_capabilities task for cross-protocol capability discovery

Introduces `get_adcp_capabilities` as a **protocol-level task** that works across all AdCP domain protocols.

**Tool-based discovery:**
- AdCP discovery uses native MCP/A2A tool discovery
- Presence of `get_adcp_capabilities` tool indicates AdCP support
- Distinctive name ensures no collision with other protocols' capability tools
- Deprecates `adcp-extension.json` agent card extension

**Cross-protocol design:**
- `adcp.major_versions` - Declare supported AdCP major versions
- `supported_protocols` - Which domain protocols are supported (media_buy, signals)
- Protocol-specific capability sections nested under protocol name

**Media-buy capabilities (media_buy section):**
- `features` - Optional features (inline_creative_management, property_list_filtering, content_standards)
- `execution.axe_integrations` - Agentic ad exchange URLs
- `execution.creative_specs` - VAST/MRAID version support
- `execution.targeting` - Geo targeting with granular system support
- `portfolio` - Publisher domains, channels, countries

**Geo targeting:**
- Countries (ISO 3166-1 alpha-2)
- Regions (ISO 3166-2)
- Metros with named systems (nielsen_dma, uk_itl1, uk_itl2, eurostat_nuts2)
- Postal areas with named systems encoding country and precision (us_zip, gb_outward, ca_fsa, etc.)

**Product filters:**
- Added `required_geo_targeting` - filter to sellers supporting specific geo capabilities with two-layer structure:
  - `level`: targeting granularity (country, region, metro, postal_area)
  - `system`: classification taxonomy for levels with multiple systems (e.g., 'nielsen_dma' for metro, 'us_zip' for postal_area)
- Added required_axe_integrations, required_features capability filters
- Product filters use `countries` for coverage and `required_geo_targeting` for capability discovery (no metros/regions filters - products don't have metro-specific coverage)

**Targeting schema:**
- Updated `targeting.json` with structured geo systems
- `geo_metros` and `geo_postal_areas` now require system specification
- System names encode country and precision (us_zip, gb_outward, nielsen_dma, etc.)
- Aligns with capability declarations in get_adcp_capabilities

**Governance capabilities (governance section):**
- `property_features` - Array of features this governance agent can evaluate
- Each feature has: `feature_id`, `type` (binary/quantitative/categorical), optional `range`/`categories`
- Deprecates `list_property_features` task (schemas removed, doc page retained with migration guide)

**Capability contract:** If a capability is declared, the seller MUST honor it.
