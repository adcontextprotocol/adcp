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

Builder Tools:
- Add brand.html builder tool for creating brand.json files
- Supports all 4 variants: portfolio, house redirect, agent, authoritative location
- Live JSON preview with copy/download functionality
- Domain validation against existing brand.json files

Manifest Reference Registry:
- Add manifest_references table for member-contributed references (not content)
- References point to URLs or MCP agents where members host their own manifests
- Support both brand.json and adagents.json references
- Verification status tracking (pending, valid, invalid, unreachable)
- Completeness scoring for ranking when multiple refs exist for same domain

Infrastructure:
- Add BrandManager service for validation and resolution from well-known URLs
- Add MCP tools: resolve_brand, validate_brand_json, validate_brand_agent
- Add manifest reference API routes: list, lookup, create, verify, delete
- Add TypeScript types: BrandConfig, BrandDefinition, HouseDefinition, ResolvedBrand

Admin UI:
- Add /admin/manifest-refs page for unified manifest registry management
- Show all member-contributed references with verification status
- Add/verify/delete references to brand.json and adagents.json

Documentation:
- Add Brand Protocol section as standalone (not under Governance)
- Complete brand.json specification with all 4 variants documented
