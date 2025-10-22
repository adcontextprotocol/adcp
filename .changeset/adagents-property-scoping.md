---
"adcontextprotocol": major
---

**BREAKING CHANGE**: Restructure `list_authorized_properties` response to return publisher authorizations instead of full property objects. Properties are now fetched from publisher canonical `adagents.json` files.

**Architecture Change: Publishers Own Property Definitions**

`list_authorized_properties` now works like IAB Tech Lab's sellers.json - it lists which publishers an agent represents, not full property details. Buyers fetch actual property definitions from each publisher's canonical adagents.json file.

**Before (v2.x)**:
```json
{
  "properties": [{...full property objects...}],
  "tags": {...}
}
```

**After (v3.0)**:
```json
{
  "publisher_authorizations": [
    {
      "publisher_domain": "cnn.com",
      "property_tags": ["ctv"]
    }
  ]
}
```

Buyers then fetch `https://cnn.com/.well-known/adagents.json` for actual property definitions.

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

**Benefits:**

- **Single source of truth**: Publishers define properties once in their own adagents.json
- **No duplication**: Agents don't copy property data, they reference it
- **Automatic updates**: Agent authorization reflects publisher property changes without manual sync
- **Simpler agents**: Agents return authorization list, not property details
- **Buyer validation**: Buyers verify authorization by checking publisher's adagents.json
- **Scalability**: Works for agents representing 1 or 1000 publishers

**Use Cases:**

- **Third-Party Sales Networks**: CTV specialist represents multiple publishers without duplicating property data
- **Publisher Direct**: Publisher's own agent references their domain, buyers fetch properties from publisher file
- **Meta Multi-Brand**: Single agent for Instagram, Facebook, WhatsApp using property tags
- **Tumblr Subdomain Control**: Authorize root domain only, NOT user subdomains
- **Authorization Validation**: Buyers verify agent is in publisher's authorized_agents list

**Domain Matching Rules:**

Follows web conventions while requiring explicit authorization for non-standard subdomains:
- `"example.com"` → Matches base domain + www + m (standard web/mobile subdomains)
- `"edition.example.com"` → Matches only that specific subdomain
- `"*.example.com"` → Matches ALL subdomains but NOT base domain

**Rationale**: www and m are conventionally the same site. Other subdomains require explicit listing.

**Migration Guide:**

Sales agents need to update `list_authorized_properties` implementation:

**Old approach (v2.x)**:
1. Fetch/maintain full property definitions
2. Return complete property objects in response
3. Keep property data synchronized with publishers

**New approach (v3.0)**:
1. Read `publisher_properties` from own adagents.json
2. Return just publisher domains + authorization scope
3. No need to maintain property data - buyers fetch from publishers

Buyer agents need to update workflow:
1. Call `list_authorized_properties` to get publisher list
2. Fetch each publisher's adagents.json
3. Validate agent is in publisher's authorized_agents
4. Resolve property scope (property_ids or property_tags)
5. Cache publisher properties for product validation

**Backward Compatibility:** Breaking change in `list_authorized_properties` response structure. `adagents.json` changes are additive (new optional fields).
