---
"adcontextprotocol": minor
---

Add Brand Protocol for brand discovery and identity resolution

Schema:
- Add brand.json schema with 4 mutually exclusive variants:
  - Authoritative location redirect
  - House redirect (string domain)
  - Brand agent (MCP-based)
  - House portfolio (full brand hierarchy)
- Support House/Brand/Property hierarchy parallel to Publisher/Property/Inventory
- Add keller_type for brand architecture (master, sub-brand, endorsed, independent)
- Add flat names array for localized brand names and aliases
- Add parent_brand for sub-brand relationships
- Add properties array on brands for digital property ownership

Infrastructure:
- Add database migrations for hosted_brands, discovered_brands, brand_properties tables
- Add brands column to member_profiles for brand ownership
- Add BrandManager service for validation and resolution
- Add BrandDatabase service for CRUD operations on brand tables
- Add MCP tools: resolve_brand, validate_brand_json, validate_brand_agent, enrich_brand
- Add TypeScript types: BrandConfig, BrandDefinition, HouseDefinition, ResolvedBrand

Brandfetch Integration:
- Add Brandfetch API service for brand enrichment (logos, colors, company info)
- Support explicit enrichment via enrich_brand tool (no automatic fallback)
- Save enriched brands to discovered_brands table with source: 'enriched'

Admin UI:
- Add /admin/brands page for brand registry management
- Show all brands with source (authoritative/hosted/enriched), manifest status
- Research brands using Brandfetch and save to registry
- Create/delete hosted brands

Addie Tools:
- Add research_brand tool to research brands via Brandfetch
- Add resolve_brand tool to resolve brand identities
- Add save_brand tool to save researched brands to registry
- Add list_brands tool to query the brand registry

Property Registry (Synthetic adagents.json):
- Add hosted_properties table for synthetic adagents.json we manage
- Add PropertyDatabase service for CRUD operations
- Add property API routes: list, resolve, validate, create/delete hosted
- Add /admin/properties page for property registry management
- Add Addie tools: validate_adagents, resolve_property, save_property, list_properties

Documentation:
- Add Brand Protocol section as standalone (not under Governance)
- Move brand docs from docs/governance/brand/ to docs/brand-protocol/
- Update brand-manifest.mdx to reference new Brand Protocol docs
