---
"adcontextprotocol": minor
---

Restructure property references across the protocol to use `publisher_properties` pattern. Publishers are the single source of truth for property definitions.

**Architecture Change: Publishers Own Property Definitions**

`list_authorized_properties` now works like IAB Tech Lab's sellers.json - it lists which publishers an agent represents. Buyers fetch each publisher's adagents.json to see property definitions and verify authorization scope.

**Key Changes:**

1. **list_authorized_properties response** - Simplified to just domains:
```json
// Before (v2.x)
{"properties": [{...}], "tags": {...}}

// After (v2.3)
{"publisher_domains": ["cnn.com", "espn.com"]}
```

2. **Product property references** - Changed to publisher_properties:
```json
// Before (v2.x)
{
  "properties": [{...full objects...}]
  // OR
  "property_tags": ["premium"]
}

// After (v2.3)
{
  "publisher_properties": [
    {
      "publisher_domain": "cnn.com",
      "property_tags": ["ctv"]
    }
  ]
}
```

Buyers fetch `https://cnn.com/.well-known/adagents.json` for:
- Property definitions (cnn.com is source of truth)
- Agent authorization verification
- Property tag definitions

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

**New approach (v2.3+)**:
1. Read `publisher_properties` from own adagents.json
2. Extract unique publisher domains
3. Return just the list of publisher domains
4. No need to maintain property data - buyers fetch from publishers

Buyer agents need to update workflow:
1. Call `list_authorized_properties` to get publisher domain list
2. Fetch each publisher's adagents.json
3. Find agent in publisher's authorized_agents array
4. Resolve authorization scope from publisher's file (property_ids, property_tags, or all)
5. Cache publisher properties for product validation

**Backward Compatibility:** Response structure changed but this is pre-1.0, so treated as minor version. `adagents.json` changes are additive (new optional fields).
