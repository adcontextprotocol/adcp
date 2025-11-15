# Changelog

## 2.5.0

### Minor Changes

- cbc95ae: Add explicit discriminator fields to discriminated union types for better TypeScript type generation

  **Schema Changes:**

  - **product.json**: Add `selection_type` discriminator ("by_id" | "by_tag") to `publisher_properties` items
  - **adagents.json**: Add `authorization_type` discriminator ("property_ids" | "property_tags" | "inline_properties" | "publisher_properties") to `authorized_agents` items, and nested `selection_type` discriminator to `publisher_properties` arrays
  - **format.json**: Add `item_type` discriminator ("individual" | "repeatable_group") to `assets_required` items

  **Rationale:**

  Without explicit discriminators, TypeScript generators produce poor types - either massive unions with broken type narrowing or generic index signatures. With discriminators, TypeScript can properly narrow types and provide excellent IDE autocomplete.

  **Migration Guide:**

  All schema changes are **additive** - new required discriminator fields are added to existing structures:

  **Product Schema (`publisher_properties`):**

  ```json
  // Before
  {
    "publisher_domain": "cnn.com",
    "property_ids": ["cnn_ctv_app"]
  }

  // After
  {
    "publisher_domain": "cnn.com",
    "selection_type": "by_id",
    "property_ids": ["cnn_ctv_app"]
  }
  ```

  **AdAgents Schema (`authorized_agents`):**

  ```json
  // Before
  {
    "url": "https://agent.com",
    "authorized_for": "All inventory",
    "property_ids": ["site_123"]
  }

  // After
  {
    "url": "https://agent.com",
    "authorized_for": "All inventory",
    "authorization_type": "property_ids",
    "property_ids": ["site_123"]
  }
  ```

  **Format Schema (`assets_required`):**

  ```json
  // Before
  {
    "asset_group_id": "product",
    "repeatable": true,
    "min_count": 3,
    "max_count": 10,
    "assets": [...]
  }

  // After
  {
    "item_type": "repeatable_group",
    "asset_group_id": "product",
    "min_count": 3,
    "max_count": 10,
    "assets": [...]
  }
  ```

  Note: The `repeatable` field has been removed from format.json as it's redundant with the `item_type` discriminator.

  **Validation Impact:**

  Schemas now have stricter validation - implementations must include the discriminator fields. This ensures type safety and eliminates ambiguity when parsing union types.

- 161cb4e: Add required package-level pricing fields to delivery reporting schema to match documentation.

  **Schema Changes:**

  - Added required `pricing_model` field to `by_package` items in `get-media-buy-delivery-response.json`
  - Added required `rate` field to `by_package` items for pricing rate information
  - Added required `currency` field to `by_package` items to support per-package currency

  These required fields enable buyers to see pricing information directly in delivery reports for better cost analysis and reconciliation, as documented in the recently enhanced reporting documentation (#179).

- a8471c4: Enforce atomic operation semantics with success XOR error response pattern. Task response schemas now use `oneOf` discriminators to ensure responses contain either complete success data OR error information, never both, never neither.

  **Response Pattern:**

  All mutating operations (create, update, build) now enforce strict either/or semantics:

  1. **Success response** - Operation completed fully:

     ```json
     {
       "media_buy_id": "mb_123",
       "buyer_ref": "campaign_2024_q1",
       "packages": [...]
     }
     ```

  2. **Error response** - Operation failed completely:
     ```json
     {
       "errors": [
         {
           "code": "INVALID_TARGETING",
           "message": "Tuesday-only targeting not supported",
           "suggestion": "Remove day-of-week constraint or select all days"
         }
       ]
     }
     ```

  **Why This Matters:**

  Partial success in advertising operations is dangerous and can lead to unintended spend or incorrect targeting. For example:

  - Buyer requests "US targeting + Tuesday-only dayparting"
  - Partial success returns created media buy without Tuesday constraint
  - Buyer might not notice error, campaign runs with wrong targeting
  - Result: Budget spent on unwanted inventory

  The `oneOf` discriminator enforces atomic semantics at the schema level - operations either succeed completely or fail completely. Buyers must explicitly choose to modify their requirements rather than having the system silently omit constraints.

  **Updated Schemas:**

  All mutating operation schemas now use `oneOf` with explicit success/error branches:

  **Media Buy Operations:**

  - `create-media-buy-response.json` - Success requires `media_buy_id`, `buyer_ref`, `packages`; Error requires `errors` array
  - `update-media-buy-response.json` - Success requires `media_buy_id`, `buyer_ref`; Error requires `errors` array
  - `build-creative-response.json` - Success requires `creative_manifest`; Error requires `errors` array
  - `provide-performance-feedback-response.json` - Success requires `success: true`; Error requires `errors` array
  - `sync-creatives-response.json` - Success requires `creatives` array (with per-item results); Error requires `errors` array (operation-level failures only)

  **Signals Operations:**

  - `activate-signal-response.json` - Success requires `decisioning_platform_segment_id`; Error requires `errors` array

  **Webhook Validation:**

  - `webhook-payload.json` - Uses conditional validation (`if/then` with `allOf`) to validate result field against the appropriate task response schema based on task_type. Ensures webhook results are properly validated against their respective task schemas.

  **Schema Structure:**

  ```json
  {
    "oneOf": [
      {
        "description": "Success response",
        "required": ["media_buy_id", "buyer_ref", "packages"],
        "not": { "required": ["errors"] }
      },
      {
        "description": "Error response",
        "required": ["errors"],
        "not": { "required": ["media_buy_id", "buyer_ref", "packages"] }
      }
    ]
  }
  ```

  The `not` constraints ensure responses cannot contain both success and error fields simultaneously.

  **Benefits:**

  - **Safety**: Prevents dangerous partial success scenarios in advertising operations
  - **Clarity**: Unambiguous success vs failure - no mixed signals
  - **Validation**: Schema-level enforcement of atomic semantics
  - **Consistency**: All mutating operations follow same pattern

  **Batch Operations Pattern**

  `sync_creatives` uses a two-level error model that distinguishes:

  - **Operation-level failures** (oneOf error branch): Authentication failed, service down, invalid request format - no creatives processed
  - **Per-item failures**: Individual creative validation errors (action='failed' within the creatives array) - rest of batch still processed

  This provides best-effort batch semantics (process what you can, report what failed) while maintaining atomic operation boundaries (either you can process the batch OR you can't).

  **Migration:**

  This is a backward-compatible change. Existing valid responses (success with all required fields) continue to validate successfully. The change prevents invalid responses (missing required success fields or mixing success/error fields) that were technically possible but semantically incorrect.

  **Alignment with Protocol Standards:**

  This pattern aligns with both MCP and A2A error handling:

  - **MCP**: Tool returns either result content OR sets `isError: true`, not both
  - **A2A**: Task reaches terminal state `completed` OR `failed`, not both
  - **AdCP**: Task payload contains success data XOR errors, enforced at schema level

- 0b76037: Add batch preview and direct HTML embedding support to `preview_creative` task for dramatically faster preview workflows.

  **Enhancements:**

  1. **Batch Mode** - Preview 1-50 creatives in one API call (5-10x faster)

     - Request includes `requests` array instead of single creative
     - Response returns `results` array with success/error per creative
     - Supports partial success (some succeed, others fail)
     - Order preservation (results match request order)

  2. **Direct HTML Embedding** - Skip iframes entirely with `output_format: "html"`
     - Request includes `output_format: "html"` parameter
     - Response includes `preview_html` field with raw HTML
     - No iframe overhead - embed HTML directly in page
     - Perfect for grids of 50+ previews
     - Batch-level and per-request `output_format` support

  **Benefits:**

  - **Performance**: 5-10x faster for 10+ creatives (single HTTP round trip)
  - **Scalability**: No 50 iframe requests for preview grids
  - **Flexibility**: Mix formats and output types in one batch
  - **Developer Experience**: Simpler grid rendering with direct HTML

  **Backward Compatibility:**

  - Existing requests unchanged (same request/response structure)
  - Default `output_format: "url"` maintains iframe behavior
  - Schema uses `oneOf` for seamless mode detection
  - No breaking changes

  **Use Cases:**

  - Bulk creative review UIs with 50+ preview grids
  - Campaign management dashboards
  - A/B testing creative variations
  - Multi-format preview generation

  **Schema Changes:**

  - `/schemas/v1/creative/preview-creative-request.json`:
    - Accepts single OR batch requests via `oneOf`
    - New `output_format` parameter ("url" | "html")
  - `/schemas/v1/creative/preview-creative-response.json`:
    - Returns single OR batch responses via `oneOf`
    - New `preview_html` field in renders (alternative to `preview_url`)

  **Documentation Improvements:**

  - **Common Workflows** section with real-world examples:
    - Format showcase pages (catalog of all available formats)
    - Creative review grids (campaign approval workflows)
    - Web component integration patterns
  - **Best Practices** section covering:
    - When to use URL vs HTML output
    - Batch request optimization strategies
    - Three production-ready architecture patterns
    - Caching strategies for URLs vs HTML
    - Error handling patterns
  - Clear guidance on building efficient applications with 50+ preview grids

- 32ca877: Consolidate agent registry into main repository and unify server architecture.

  **Breaking Changes:**

  - Agent registry moved from separate repository into `/registry` directory
  - Unified Express server now serves homepage, registry UI, schemas, and API endpoints
  - Updated server dependencies and structure

  **New Features:**

  - Single unified server for all AdCP services (homepage, registry, schemas, API, MCP)
  - Updated homepage with working documentation links
  - Slack community navigation link
  - Applied 4dvertible → Advertible Inc rebranding (registry PR #8)

  **Documentation:**

  - Consolidated UNIFIED-SERVER.md, CONSOLIDATION.md, and REGISTRY.md content into main README
  - Updated repository structure documentation
  - Added Docker deployment instructions

- 2a126fe: - Enhanced `get_media_buy_delivery` response to include package-level pricing information: `pricing_model`, `rate`, and `currency` fields added to `by_package` section.

  - Added offline file delivery examples for JSON Lines (JSONL), CSV, and Parquet formats.
  - Added tab structure to list different formats of offline delivery files in optimization reporting documentation.
  - Updated all delivery reporting examples to include new pricing fields.
  - Added comprehensive JSONL, CSV, and Parquet format examples with schema documentation.

  **Impact:**

  - Buyers can now see pricing information directly in delivery reports for better cost analysis.
  - Publishers have clearer guidance on structured batch reporting formats that maintain nested data.
  - Documentation provides a detailed examples for implementing offline file delivery.

- 4bf2874: Application-Level Context in Task Payloads

  - Task request schemas now accept an optional `context` object provided by the initiator
  - Task response payloads (and webhook `result` payloads) echo the same `context`

- 649aa2d: Add activation key support for signal protocol with permission-based access. Enables signal agents and buyers to receive activation keys (segment IDs or key-value pairs) based on authenticated permissions.

  **Breaking Changes:**

  - `activate_signal` response: Changed from single `activation_key` field to `deployments` array
  - Both `get_signals` and `activate_signal` now consistently use `destinations` (plural)

  **New Features:**

  - Universal `activation-key.json` schema supporting segment IDs and key-value pairs
  - Flexible destination model supporting DSP platforms (string) and sales agents (URL)
  - Permission-based key inclusion determined by signal agent authentication
  - Buyers with multi-platform credentials receive keys for all authorized platforms

  **New Schemas:**

  - `activation-key.json` - Universal activation key supporting segment_id and key_value types

  **Modified Schemas:**

  - `get-signals-request.json` - destinations array with platform OR agent_url
  - `get-signals-response.json` - deployments include activation_key when authorized
  - `activate-signal-request.json` - destinations array (plural)
  - `activate-signal-response.json` - deployments array with per-destination keys

  **Security:**

  - Removed `requester` flag (can't be spoofed)
  - Signal agent validates caller has access to requested destinations
  - Permission-based access control via authentication layer

- 17f3a16: Add discriminator fields to multiple schemas for improved TypeScript type safety and reduced union signature complexity.

  **Breaking Changes**: The following schemas now require discriminator fields:

  **Signal Schemas:**

  - `destination.json`: Added discriminator with `type: "platform"` or `type: "agent"`
  - `deployment.json`: Added discriminator with `type: "platform"` or `type: "agent"`

  **Creative Asset Schemas:**

  - `sub-asset.json`: Added discriminator with `asset_kind: "media"` or `asset_kind: "text"`
  - `vast-asset.json`: Added discriminator with `delivery_type: "url"` or `delivery_type: "inline"`
  - `daast-asset.json`: Added discriminator with `delivery_type: "url"` or `delivery_type: "inline"`

  **Preview Response Schemas:**

  - `preview-render.json`: NEW schema extracting render object with proper `oneOf` discriminated union
  - `preview-creative-response.json`: Refactored to use `$ref` to `preview-render.json` instead of inline `allOf`/`if`/`then` patterns

  **Benefits:**

  - Reduces TypeScript union signature count significantly (estimated ~45 to ~20)
  - Enables proper discriminated unions in TypeScript across all schemas
  - Eliminates broken index signature intersections from `allOf`/`if`/`then` patterns
  - Improves IDE autocomplete and type checking
  - Provides type-safe discrimination between variants
  - Single source of truth for shared schema structures (DRY principle)
  - 51% reduction in preview response schema size (380 → 188 lines)

  **Migration Guide:**

  ### Signal Destinations and Deployments

  **Before:**

  ```json
  {
    "destinations": [
      {
        "platform": "the-trade-desk",
        "account": "agency-123"
      }
    ]
  }
  ```

  **After:**

  ```json
  {
    "destinations": [
      {
        "type": "platform",
        "platform": "the-trade-desk",
        "account": "agency-123"
      }
    ]
  }
  ```

  For agent URLs:

  ```json
  {
    "destinations": [
      {
        "type": "agent",
        "agent_url": "https://wonderstruck.salesagents.com"
      }
    ]
  }
  ```

  ### Sub-Assets

  **Before:**

  ```json
  {
    "asset_type": "headline",
    "asset_id": "main_headline",
    "content": "Premium Products"
  }
  ```

  **After:**

  ```json
  {
    "asset_kind": "text",
    "asset_type": "headline",
    "asset_id": "main_headline",
    "content": "Premium Products"
  }
  ```

  For media assets:

  ```json
  {
    "asset_kind": "media",
    "asset_type": "product_image",
    "asset_id": "hero_image",
    "content_uri": "https://cdn.example.com/image.jpg"
  }
  ```

  ### VAST/DAAST Assets

  **Before:**

  ```json
  {
    "url": "https://vast.example.com/tag",
    "vast_version": "4.2"
  }
  ```

  **After:**

  ```json
  {
    "delivery_type": "url",
    "url": "https://vast.example.com/tag",
    "vast_version": "4.2"
  }
  ```

  For inline content:

  ```json
  {
    "delivery_type": "inline",
    "content": "<VAST version=\"4.2\">...</VAST>",
    "vast_version": "4.2"
  }
  ```

  ### Preview Render Output Format

  **Note:** The `output_format` discriminator already existed in the schema. This change improves TypeScript type generation by replacing `allOf`/`if`/`then` conditional logic with proper `oneOf` discriminated unions. **No API changes required** - responses remain identical.

  **Schema pattern (existing behavior, better typing):**

  ```json
  {
    "renders": [
      {
        "render_id": "primary",
        "output_format": "url",
        "preview_url": "https://...",
        "role": "primary"
      }
    ]
  }
  ```

  The `output_format` field acts as a discriminator:

  - `"url"` → only `preview_url` field present
  - `"html"` → only `preview_html` field present
  - `"both"` → both `preview_url` and `preview_html` fields present

- b7745a4: - Standardize webhook payload: protocol envelope at top-level; task-specific data moved under result.
  - Result schema is bound to task_type via JSON Schema refs; result MAY be present for any status (including failed).
  - Error remains a string; can appear alongside result.
  - Required fields updated to: task_id, task_type, status, timestamp. Domain is no longer required.
  - Docs updated to reflect envelope + result model.
  - Compatibility: non-breaking for users of adcp/client (already expects result); breaking for direct webhook consumers that parsed task fields at the root.
- 058ee19: Add visual card support for products and formats. Publishers and creative agents can now include optional card definitions that reference card formats and provide visual assets for display in user interfaces.

  **New schema fields:**

  - `product_card` and `product_card_detailed` fields in Product schema (both optional)
  - `format_card` and `format_card_detailed` fields in Format schema (both optional)

  **Two-tier card system:**

  - **Standard cards**: Compact 300x400px cards (2x density support) for browsing grids
  - **Detailed cards**: Responsive layout with description alongside hero carousel, markdown specs below

  **Rendering flexibility:**

  - Cards can be rendered dynamically via `preview_creative` task
  - Or pre-generated and served as static CDN assets
  - Publishers/agents choose based on infrastructure

  **Standard card format definitions:**

  - `product_card_standard`, `product_card_detailed`, `format_card_standard`, `format_card_detailed`
  - Will be added to the reference creative-agent repository
  - Protocol specification only defines the schema fields, not the format implementations

  **Deprecation:**

  - `preview_image` field in Format schema is now deprecated (but remains functional)
  - Will be removed in v3.0.0
  - Migrate to `format_card` for better flexibility and structure

  **Benefits:**

  - Improved product/format discovery UX with visual cards
  - Detailed cards provide media-kit-style presentation (description left, carousel right, specs below)
  - Consistent card rendering across implementations
  - Uses AdCP's own creative format system for extensibility
  - Non-breaking: Completely additive, existing implementations continue to work

### Patch Changes

- 16f632a: Add explicit type declarations to discriminator fields in JSON schemas.

  All discriminator fields using `const` now include explicit `"type"` declarations (e.g., `"type": "string", "const": "value"`). This enables TypeScript generators to produce proper literal types instead of `Any`, improving type safety and IDE autocomplete.

  **Fixed schemas:**

  - daast-asset.json: delivery_type discriminators
  - vast-asset.json: delivery_type discriminators
  - preview-render.json: output_format discriminators
  - deployment.json: type discriminators
  - sub-asset.json: asset_kind discriminators
  - preview-creative-response.json: response_type and success discriminators

  **Documentation:**

  - Updated CLAUDE.md with best practices for discriminator field typing

- b09ddd6: Update homepage documentation links to external docs site. All documentation links on the homepage, navigation, and footer now point to https://docs.adcontextprotocol.org instead of local paths, directing users to the hosted documentation site.
- 8904e6c: Fix broken documentation links for Mintlify deployment.

  Converted all relative internal links to absolute Mintlify-compatible paths with `/docs/` prefix. This fixes 389 broken links across 50 documentation files that were causing 404 errors when users clicked them on docs.adcontextprotocol.org.

  **Technical details:**

  - Changed relative paths like `./reference/release-notes` to absolute `/docs/reference/release-notes`
  - Mintlify requires absolute paths with `/docs/` prefix and no file extensions
  - Links now match Mintlify's URL structure and routing expectations

  Fixes #167

- ddeef70: Fix Slack working group invite link in community documentation. The previous invite URL was not functional; replaced with working invite link for the agenticads Slack workspace.
- 259727a: Add discriminator fields to preview_creative request and response schemas.

  **Changes:**

  - Added `request_type` discriminator to preview-creative-request.json ("single" | "batch")
  - Added `response_type` discriminator to preview-creative-response.json ("single" | "batch")

  **Why:**
  Explicit discriminator fields enable TypeScript generators to produce proper discriminated unions with excellent type narrowing and IDE autocomplete. Without discriminators, generators produce index signatures or massive union types with poor type safety.

  **Migration:**
  Request format:

  ```json
  // Before
  { "format_id": {...}, "creative_manifest": {...} }

  // After (single)
  { "request_type": "single", "format_id": {...}, "creative_manifest": {...} }

  // Before
  { "requests": [...] }

  // After (batch)
  { "request_type": "batch", "requests": [...] }
  ```

  Response format:

  ```json
  // Before
  { "previews": [...], "expires_at": "..." }

  // After (single)
  { "response_type": "single", "previews": [...], "expires_at": "..." }

  // Before
  { "results": [...] }

  // After (batch)
  { "response_type": "batch", "results": [...] }
  ```

- 435a624: Add output_format discriminator to preview render schema for improved validation performance.

  Replaces oneOf constraint on render objects with an explicit output_format field ("url", "html", or "both") that indicates which preview fields are present. This eliminates the need for validators to try all three combinations when validating preview responses, significantly improving validation speed for responses with multiple renders (companion ads, multi-placement formats).

  **Schema change:**

  - Added required `output_format` field to render objects in preview-creative-response.json
  - Replaced `oneOf` validation with conditional `allOf` based on discriminator value
  - Updated field descriptions to reference the discriminator

  **Backward compatibility:**

  - Breaking change: Existing preview responses must add the output_format field
  - Creative agents implementing preview_creative task must update responses

- 10cc797: Refactor signals schemas to use reusable core destination and deployment schemas.

  **Changes:**

  - Created `/schemas/v1/core/destination.json` - reusable schema for signal activation destinations (DSPs, sales agents, etc.)
  - Created `/schemas/v1/core/deployment.json` - reusable schema for signal deployment status and activation keys
  - Updated all signals task schemas to reference the new core schemas instead of duplicating definitions
  - Added destination and deployment to schema registry index

  **Benefits:**

  - Eliminates schema duplication across 4 signal task schemas
  - Ensures consistent validation of destination and deployment objects
  - Improves type safety - single source of truth for these data structures
  - Simplifies maintenance - changes to destination/deployment structure only need updates in one place

  **Affected schemas:**

  - `get-signals-request.json` - destinations array now uses `$ref` to core destination schema
  - `get-signals-response.json` - deployments array now uses `$ref` to core deployment schema
  - `activate-signal-request.json` - destinations array now uses `$ref` to core destination schema
  - `activate-signal-response.json` - deployments array now uses `$ref` to core deployment schema

  This is a non-breaking change - the validation behavior remains identical, only the schema structure is improved.

- 4c76776: Restore axe_include_segment and axe_exclude_segment targeting fields

  These fields were accidentally removed from the targeting schema and have been restored to enable AXE segment targeting functionality.

  **Restored fields:**

  - `axe_include_segment` - AXE segment ID to include for targeting
  - `axe_exclude_segment` - AXE segment ID to exclude from targeting

  **Updated documentation:**

  - Added AXE segment fields to create_media_buy task reference
  - Added detailed parameter descriptions in targeting advanced topics

## 2.3.0

### Minor Changes

- da956ff: Restructure property references across the protocol to use `publisher_properties` pattern. Publishers are the single source of truth for property definitions.

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

  1. **`contact`** _(optional)_ - Identifies who manages this file (publisher or third-party):

     - `name` - Entity managing the file (e.g., "Meta Advertising Operations")
     - `email` - Contact email for questions/issues
     - `domain` - Primary domain of managing entity
     - `seller_id` - Seller ID from IAB Tech Lab sellers.json
     - `tag_id` - TAG Certified Against Fraud ID

  2. **`properties`** _(optional)_ - Top-level property list (same structure as `list_authorized_properties`):

     - Array of Property objects with identifiers and tags
     - Defines all properties covered by this file

  3. **`tags`** _(optional)_ - Property tag metadata (same structure as `list_authorized_properties`):

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

- bf0987c: Make brand_manifest optional in get_products and remove promoted_offering.

  Sales agents can now decide whether brand context is necessary for product recommendations. This allows for more flexible product discovery workflows where brand information may not always be available or required upfront.

  **Schema changes:**

  - `get-products-request.json`: Removed `brand_manifest` from required fields array

  **Documentation changes:**

  - Removed all references to `promoted_offering` field (which never existed in schema)
  - Updated all request examples to remove `promoted_offering`
  - Updated usage notes and implementation guide to focus on `brief` and `brand_manifest`
  - Removed policy checking guidance that was tied to `promoted_offering`
  - Fixed schema-documentation mismatch where docs showed `promoted_offering` but schema had `brand_manifest`

- ff4af78: Add placement targeting for creative assignments. Enables products to define multiple placements (e.g., homepage banner, article sidebar) and buyers to assign different creatives to each placement while purchasing the entire product.

  **New schemas:**

  - `placement.json` - Placement definition with placement_id, name, description, format_ids
  - Added optional `placements` array to Product schema
  - Added optional `placement_ids` array to CreativeAssignment schema

  **Design:**

  - Packages always buy entire products (no package-level placement targeting)
  - Placement targeting only via `create_media_buy`/`update_media_buy` creative assignments
  - `sync_creatives` does NOT support placement targeting (keeps bulk operations simple)
  - Creatives without `placement_ids` run on all placements in the product

- 04cc3b9: Remove media buy level budget field. Budget is now only specified at the package level, with each package's pricing_option_id determining the currency. This simplifies the protocol by eliminating redundant budget aggregation and allows mixed-currency campaigns when sellers support it.

  **Breaking changes:**

  - Removed `budget` field from create_media_buy request (at media buy level)
  - Removed `budget` field from update_media_buy request (at media buy level)

  **Migration:**

  - Move budget amounts to individual packages
  - Each package specifies budget as a number in the currency of its pricing_option_id
  - Sellers can enforce single-currency rules if needed by validating pricing options

- 7c194f7: Add tracker_script type to URL assets for measurement SDKs. Split the `url_type` enum to distinguish between HTTP request tracking (tracker_pixel) and script tag loading (tracker_script) for OMID verification scripts and native event trackers.

### Patch Changes

- 279ded1: Clarify webhook payload structure with explicit required fields documentation.

  **Changes:**

  - Added new `webhook-payload.json` schema documenting the complete structure of webhook POST payloads
  - Added new `task-type.json` enum schema with all valid AdCP task types
  - Refactored task schemas to use `$ref` to task-type enum (eliminates duplication across 4 schemas)
  - Updated task management documentation to explicitly list required webhook fields: `task_id`, `task_type`, `domain`, `status`, `created_at`, `updated_at`
  - Enhanced webhook examples to show all required protocol-level fields
  - Added schema reference link for webhook payload structure

  **Context:**
  This clarifies an ambiguity in the spec that was causing confusion in implementations. The `task_type` field is required in webhook payloads (along with other protocol-level task metadata) but this wasn't explicitly documented before. Webhooks receive the complete task response object which includes both protocol-level fields AND domain-specific response data merged at the top level.

  **Impact:**

  - Documentation-only change, no breaking changes to existing implementations
  - Helps implementers understand the exact structure of webhook POST payloads
  - Resolves confusion about whether `task_type` is required (it is)

- 21848aa: Switch llms.txt plugin so that we get proper URLs
- 69179a2: Updated LICENSE to Apache2 and introducing CONTRIBUTING.md and IPR_POLICY.md
- cc3b86b: Add comprehensive security documentation including SECURITY.md with vulnerability disclosure policy and enhanced security guidelines covering financial transaction safety, multi-party trust model, authentication/authorization, data protection, compliance considerations, and role-specific security checklists.
- 86d9e9c: Fix URL asset field naming and simplify URL type classification.

  **Schema changes:**

  - Added `url_type` field to URL asset schema (`/schemas/v1/core/assets/url-asset.json`)
  - Simplified `url_type` to two values:
    - `clickthrough` - URL for human interaction (may redirect through ad tech)
    - `tracker` - URL that fires in background (returns pixel/204)

  **Documentation updates:**

  - Replaced all instances of `url_purpose` with `url_type` across all documentation
  - Simplified all tracking URL types (impression_tracker, click_tracker, video_start, video_complete, etc.) to just `tracker`
  - Clarified that `url_type` is only used in format requirements, not in creative manifest payloads
  - The `asset_id` field already indicates the specific purpose (e.g., `impression_tracker`, `video_start_tracker`, `landing_url`)

  **Rationale:**
  The distinction between impression_tracker, click_tracker, video_start, etc. was overly prescriptive. The `asset_id` in format definitions already tells you what the URL is semantically for. The `url_type` field distinguishes between URLs intended for human interaction (clickthrough) versus background tracking (tracker). A clickthrough may redirect through ad tech platforms before reaching the final destination, while a tracker fires in the background and returns a pixel or 204 response.

- 97ec201: Added min_width, min_height and aspect_ratio to ImageAsset type

## 2.2.0

### Minor Changes

- 727463a: Align build_creative with transformation model and consistent naming

  **Breaking changes:**

  - `build_creative` now uses `creative_manifest` instead of `source_manifest` parameter
  - `build_creative` request no longer accepts `promoted_offerings` as a task parameter (must be in manifest assets)
  - `preview_creative` request no longer accepts `promoted_offerings` as a task parameter (must be in manifest assets)
  - `build_creative` response simplified to return just `creative_manifest` (removed complex nested structure)

  **Improvements:**

  - Clear transformation model: manifest-in → manifest-out
  - Format definitions drive requirements (e.g., promoted_offerings is a format asset requirement)
  - Consistent naming across build_creative and preview_creative
  - Self-contained manifests that flow through build → preview → sync
  - Eliminated redundancy and ambiguity about where to provide inputs

  This change makes the creative generation workflow much clearer and more consistent. Generative formats that require `promoted_offerings` should specify it as a required asset in their format definition, and it should be included in the `creative_manifest.assets` object.

### Patch Changes

- eeb9967: Automate schema version synchronization with package.json

  Implemented three-layer protection to ensure schema registry version stays in sync with package.json:

  1. **Auto-staging**: update-schema-versions.js now automatically stages changes to git
  2. **Verification gate**: New verify-version-sync.js script prevents releases when versions don't match
  3. **Pre-push validation**: Git hook checks version sync before any push

  Also fixed v2.1.0 schema registry version (was incorrectly showing 2.0.0) and removed duplicate creative-manifest entry.

- 7d0c8c8: Improve documentation visibility and navigation

  **Documentation Improvements:**

  1. **Added Changelog Page**

     - Created comprehensive `/docs/reference/changelog` with v2.1.0 and v2.0.0 release notes
     - Includes developer migration guide with code examples
     - Documents breaking changes and versioning policy
     - Added to sidebar navigation in Reference section

  2. **Improved Pricing Documentation Visibility**

     - Added Pricing Models to sidebar navigation (Media Buy Protocol > Advanced Topics)
     - Added pricing information callouts to key task documentation
     - Enhanced `get_products` with pricing_options field description
     - Added missing `pricing_option_id` field to `create_media_buy` Package Object
     - Added prominent tip box linking to pricing guide in media-products.md

  3. **Added Release Banner**
     - Homepage now displays v2.1.0 release announcement with link to changelog
     - Makes new releases immediately visible to documentation readers

  **Why These Changes:**

  - Users reported difficulty finding changelog and version history
  - Pricing documentation was comprehensive but hidden from navigation
  - Critical fields like `pricing_option_id` were not documented in API reference
  - Release announcements need better visibility on homepage

  These are documentation-only changes with no code or schema modifications.

## 2.1.0

### Minor Changes

- ae091dc: Simplify asset schema architecture by separating payload from requirements

  **Breaking Changes:**

  1. **Removed `asset_type` field from creative manifest wire format**

     - Asset payloads no longer include redundant type information
     - Asset types are determined by format specification, not declared in manifest
     - Validation is format-aware using `asset_id` lookup

  2. **Deleted `/creative/asset-types/*.json` individual schemas**

     - 11 duplicate schema files removed (image, video, audio, vast, daast, text, url, html, css, javascript, webhook)
     - Asset type registry now references `/core/assets/` schemas directly
     - Schema path changed: `/creative/asset-types/image.json` → `/core/assets/image-asset.json`

  3. **Removed constraint fields from core asset payloads**
     - `vast-asset.json`: Removed `max_wrapper_depth` (format constraint, not payload data)
     - `text-asset.json`: Removed `max_length` (format constraint, not payload data)
     - `webhook-asset.json`: Removed `fallback_required` (format requirement, not asset property)
     - Constraint fields belong in format specification `requirements`, not asset schemas

  **Why These Changes:**

  - **Format-aware validation**: Creative manifests are always validated in the context of their format specification. The format already defines what type each `asset_id` should be, making `asset_type` in the payload redundant.
  - **Single source of truth**: Each asset type now defined once in `/core/assets/`, eliminating 1,797 lines of duplicate code.
  - **Clear separation of concerns**: Payload schemas describe data structure; format specifications describe constraints and requirements.
  - **Reduced confusion**: No more wondering which schema to reference or where to put constraints.

  **Migration Guide:**

  ### Code Changes

  ```diff
  // Schema references
  - const schema = await fetch('/schemas/v1/creative/asset-types/image.json')
  + const schema = await fetch('/schemas/v1/core/assets/image-asset.json')

  // Creative manifest structure (removed asset_type)
  {
    "assets": {
      "banner_image": {
  -     "asset_type": "image",
        "url": "https://cdn.example.com/banner.jpg",
        "width": 300,
        "height": 250
      }
    }
  }

  // Validation changes - now format-aware
  - // Old: Standalone asset validation
  - validate(assetPayload, imageAssetSchema)

  + // New: Format-aware validation
  + const format = await fetchFormat(manifest.format_id)
  + const assetRequirement = format.assets_required.find(a => a.asset_id === assetId)
  + const assetSchema = await fetchAssetSchema(assetRequirement.asset_type)
  + validate(assetPayload, assetSchema)
  ```

  ### Validation Flow

  1. Read `format_id` from creative manifest
  2. Fetch format specification from format registry
  3. For each asset in manifest:
     - Look up `asset_id` in format's `assets_required`
     - If not found → error "unknown asset_id"
     - Get `asset_type` from format specification
     - Validate asset payload against that asset type's schema
  4. Check all required assets are present
  5. Validate type-specific constraints from format `requirements`

  ### Constraint Migration

  Constraints moved from asset schemas to format specification `requirements` field:

  ```diff
  // Format specification assets_required
  {
    "asset_id": "video_file",
    "asset_type": "video",
    "required": true,
    "requirements": {
      "width": 1920,
      "height": 1080,
      "duration_ms": 15000,
  +   "max_file_size_bytes": 10485760,
  +   "acceptable_codecs": ["h264", "h265"]
    }
  }
  ```

  These constraints are validated against asset payloads but are not part of the payload schema itself.

### Patch Changes

- 4be4140: Add Ebiquity as founding member
- f99a4a7: Clarify asset_id usage in creative manifests

  Previously ambiguous: The relationship between `asset_id` in format definitions and the keys used in creative manifest `assets` objects was unclear.

  Now explicit:

  - Creative manifest keys MUST exactly match `asset_id` values from the format's `assets_required` array
  - `asset_role` is optional/documentary—not used for manifest construction
  - Added validation guidance: what creative agents should do with mismatched keys

  Example: If a format defines `asset_id: "banner_image"`, your manifest must use:

  ```json
  {
    "assets": {
      "banner_image": { ... }  // ← Must match asset_id
    }
  }
  ```

  Changes: Updated creative-manifest.json, format.json schemas and creative-manifests.md documentation.

- 67d7994: Fix format_id documentation to match schema specification

All notable changes to the AdCP specification will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.0.0] - 2025-10-15

### Added

- **Production Release**: AdCP v2.0.0 is the first production-ready release of the Advertising Context Protocol
- **Media Buy Tasks**: Core tasks for advertising workflow
  - `get_products` - Discover advertising inventory
  - `list_creative_formats` - Discover supported creative formats
  - `create_media_buy` - Create advertising campaigns
  - `sync_creatives` - Synchronize creative assets
  - `list_creatives` - Query creative library
  - `update_media_buy` - Update campaign settings
  - `get_media_buy_delivery` - Retrieve delivery metrics
  - `list_authorized_properties` - Discover authorized properties
  - `provide_performance_feedback` - Share performance data
- **Creative Tasks**: AI-powered creative generation
  - `build_creative` - Generate creatives from briefs
  - `preview_creative` - Generate creative previews
  - `list_creative_formats` - Discover format specifications
- **Signals Tasks**: First-party data integration
  - `get_signals` - Discover available signals
  - `activate_signal` - Activate signals for campaigns
- **Standard Formats**: Industry-standard creative formats
  - Display formats (banner, mobile, interstitial)
  - Video formats (standard, skippable, stories)
  - Native formats (responsive native)
  - Standard asset types for multi-asset creatives
- **Protocol Infrastructure**:
  - JSON Schema validation for all tasks
  - MCP (Model Context Protocol) support
  - A2A (Agent-to-Agent) protocol support
  - Task management with async workflows
  - Human-in-the-loop approval system
- **Documentation**: Comprehensive documentation
  - Protocol specification
  - Task reference guides
  - Integration guides for MCP and A2A
  - Standard formats documentation
  - Error handling documentation
- **Version Management**:
  - Changesets for automated version management
  - Single source of truth for version (schema registry only)
  - Simplified versioning: version indicated by schema path (`/schemas/v1/`)

### Changed

- Initial release, no changes from previous versions

### Design Decisions

- **Simplified Versioning**: Version is maintained only in the schema registry (`/schemas/v1/index.json`) and indicated by schema path. Individual request/response schemas and documentation do not contain version fields, reducing maintenance burden while maintaining clear version semantics.

### Technical Details

- **Schema Version**: 2.0.0
- **Standard Formats Version**: 1.0.0
- **Protocol Support**: MCP, A2A
- **Node Version**: >=18.0

### Notes

This is the first production-ready release of AdCP. Future releases will follow semantic versioning:

- **Patch versions** (2.0.x): Bug fixes and clarifications
- **Minor versions** (2.x.0): New features and enhancements (backward compatible)
- **Major versions** (x.0.0): Breaking changes

We use [Changesets](https://github.com/changesets/changesets) for version management. All changes should include a changeset file.

[2.0.0]: https://github.com/adcontextprotocol/adcp/releases/tag/v2.0.0
