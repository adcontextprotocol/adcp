---
"adcontextprotocol": minor
---

Restructure adagents.json to mirror list_authorized_properties pattern with property-scoped authorization.

**Key Design Change:**

The `adagents.json` structure now parallels `list_authorized_properties` - both use the same `properties` array with `tags` for organization. Agents reference properties via `property_tags` (recommended) or explicit `properties` lists.

**New Fields:**

1. **`contact`** *(optional)* - Identifies who manages this file (publisher or third-party):
   - `name` - Entity managing the file (e.g., "Meta Advertising Operations")
   - `email` - Contact email for questions/issues
   - `domain` - Primary domain of managing entity
   - `seller_id` - Seller ID from IAB Tech Lab sellers.json
   - `tag_id` - TAG Certified Against Fraud ID

2. **`properties`** *(optional)* - Top-level property list (same structure as `list_authorized_properties`):
   - Array of Property objects with identifiers and tags
   - Defines all properties covered by this file

3. **`tags`** *(optional)* - Property tag metadata (same structure as `list_authorized_properties`):
   - Human-readable names and descriptions for each tag

4. **Agent Authorization** - Four patterns for scoping:
   - `property_ids` - Direct property ID references within this file
   - `property_tags` - Tag-based authorization within this file
   - `properties` - Explicit property lists (inline definitions)
   - `publisher_properties` - **Recommended for third-party agents**: Reference properties from publisher's canonical adagents.json files
   - If all omitted, agent is authorized for all properties in file

5. **Property IDs** - Optional `property_id` field on Property objects:
   - Enables direct referencing (`"property_ids": ["cnn_ctv_app"]`)
   - Recommended format: lowercase with underscores
   - More efficient than repeating full property objects

6. **publisher_domain Optional** - Now optional in adagents.json:
   - Required in `list_authorized_properties` (multi-domain responses)
   - Optional in adagents.json (file location implies domain)

**Use Cases Solved:**

- **Meta**: Single agent for Instagram, Facebook, WhatsApp using `property_tags: ["meta_network"]`
- **Tumblr**: Authorize only root domain, NOT user subdomains
- **Netflix**: Different agents for mobile apps vs. website using tags
- **Third-Party Sales**: Agent references `publisher_domain: "cnn.com", property_tags: ["ctv"]` to sell publisher's CTV inventory without duplicating property definitions

**Consistency Benefits:**

- Same Property schema everywhere (adagents.json, list_authorized_properties, get_products)
- Same tag resolution logic
- Same subdomain matching rules (`*.example.com` wildcards)
- Single source of truth: publisher's adagents.json is canonical, agents reference it
- When publisher updates properties, agent authorization automatically reflects changes

**Domain Matching Rules:**

Follows web conventions while requiring explicit authorization for non-standard subdomains:
- `"example.com"` → Matches base domain + www + m (standard web/mobile subdomains)
- `"edition.example.com"` → Matches only that specific subdomain
- `"*.example.com"` → Matches ALL subdomains but NOT base domain

**Rationale**: www and m are conventionally the same site. Other subdomains require explicit listing.

**Backward Compatibility:** All new fields optional. Simple files with just `authorized_agents` still valid. Domain matching is a clarification of intended behavior.
