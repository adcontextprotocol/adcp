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
- `extensions_supported` - Extension namespaces this agent supports (e.g., `["scope3", "garm"]`)
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

**Product filters - two models for geography:**

*Coverage filters (for locally-bound inventory like radio, OOH, local TV):*
- `countries` - country coverage (ISO 3166-1 alpha-2)
- `regions` - region coverage (ISO 3166-2) for regional OOH, local TV
- `metros` - metro coverage ({ system, code }) for radio, DOOH, DMA-based inventory

*Capability filters (for digital inventory with broad coverage):*
- `required_geo_targeting` - filter by seller capability with two-layer structure:
  - `level`: targeting granularity (country, region, metro, postal_area)
  - `system`: classification taxonomy (e.g., 'nielsen_dma', 'us_zip')
- `required_axe_integrations` - filter by AXE support
- `required_features` - filter by protocol feature support

Use coverage filters when products ARE geographically bound (radio station = DMA).
Use capability filters when products have broad coverage and you'll target at buy time.

**Targeting schema:**
- Updated `targeting.json` with structured geo systems
- `geo_metros` and `geo_postal_areas` now require system specification
- System names encode country and precision (us_zip, gb_outward, nielsen_dma, etc.)
- Aligns with capability declarations in get_adcp_capabilities

**Governance capabilities (governance section):**
- `property_features` - Array of features this governance agent can evaluate
- Each feature has: `feature_id`, `type` (binary/quantitative/categorical), optional `range`/`categories`
- `methodology_url` - Optional URL to methodology documentation (helps buyers understand/compare vendor approaches)
- Deprecates `list_property_features` task (schemas removed, doc page retained with migration guide)

**Capability contract:** If a capability is declared, the seller MUST honor it.
