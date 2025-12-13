# Changelog

## 2.5.1

### Patch Changes

- 72a5802: Fix semantic version sorting for agreements. When multiple agreement versions share the same effective date, the system now correctly selects the highest version (e.g., 1.1.1 before 1.1).
- 10d5b6a: Fix analytics dashboard revenue tracking with Stripe webhook customer linkage
- 64b08a1: Redesign how AdCP handles push notifications for async tasks. The key change is separating **what data is sent** (AdCP's responsibility) from **how it's delivered** (protocol's responsibility).

  **Renamed:**

  - `webhook-payload.json` → `mcp-webhook-payload.json` (clarifies this envelope is MCP-specific)

  **Created:**

  - `async-response-data.json` - Union schema for all async response data types
  - Status-specific schemas for `working`, `input-required`, and `submitted` statuses

  **Deleted:**

  - Removed redundant `-async-response-completed.json` and `-async-response-failed.json` files (6 total)
  - For `completed`/`failed`, we now use the existing task response schemas directly

  **Before:** The webhook spec tried to be universal, which created confusion about how A2A's native push notifications fit in.

  **After:**

  - MCP uses `mcp-webhook-payload.json` as its envelope, with AdCP data in `result`
  - A2A uses its native `Task`/`TaskStatusUpdateEvent` messages, with AdCP data in `status.message.parts[].data`
  - Both use the **exact same data schemas** - only the envelope differs

  This makes it clear that AdCP only specifies the data layer, while each protocol handles delivery in its own way.

  **Schemas:**

  - `static/schemas/source/core/mcp-webhook-payload.json` (renamed + simplified)
  - `static/schemas/source/core/async-response-data.json` (new)
  - `static/schemas/source/media-buy/*-async-response-*.json` (6 deleted, 9 remain)

  - Clarified that both MCP and A2A use HTTP webhooks (A2A's is native to the spec, MCP's is AdCP-provided)
  - Fixed webhook trigger rules: webhooks fire for **all status changes** if `pushNotificationConfig` is provided and the task runs async
  - Added proper A2A webhook payload examples (`Task` vs `TaskStatusUpdateEvent`)
  - **Task Management** added to sidebar, it was missing

## 2.5.0

### Minor Changes

- cbc95ae: Add explicit discriminator fields to discriminated union types for better TypeScript type generation

  **Schema Changes:**

  - **product.json**: Add `selection_type` discriminator ("all" | "by_id" | "by_tag") to `publisher_properties` items. The new "all" variant enables representing all properties from a publisher domain without requiring explicit IDs or tags.
  - **adagents.json**: Add `authorization_type` discriminator ("property_ids" | "property_tags" | "inline_properties" | "publisher_properties") to `authorized_agents` items, and nested `selection_type` discriminator ("all" | "by_id" | "by_tag") to `publisher_properties` arrays
  - **format.json**: Add `item_type` discriminator ("individual" | "repeatable_group") to `assets_required` items

  **Rationale:**

  Without explicit discriminators, TypeScript generators produce poor types - either massive unions with broken type narrowing or generic index signatures. With discriminators, TypeScript can properly narrow types and provide excellent IDE autocomplete.

  **Migration Guide:**

  All schema changes are **additive** - new required discriminator fields are added to existing structures:

  **Product Schema (`publisher_properties`):**

  ```json
  // Before (property IDs)
  {
    "publisher_domain": "cnn.com",
    "property_ids": ["cnn_ctv_app"]
  }

  // After (property IDs)
  {
    "publisher_domain": "cnn.com",
    "selection_type": "by_id",
    "property_ids": ["cnn_ctv_app"]
  }

  // New: All properties from publisher
  {
    "publisher_domain": "cnn.com",
    "selection_type": "all"
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

- c561479: Make create_media_buy and update_media_buy responses consistent by returning full Package objects.

  **Changes:**

  - `create_media_buy` response now returns full Package objects instead of just package_id + buyer_ref
  - `update_media_buy` response already returned full Package objects (no change to behavior)
  - Both responses now have identical Package structure for consistency

  **Benefits:**

  - **Consistency**: Both create and update operations return the same response structure
  - **Full state visibility**: Buyers see complete package state including budget, status, targeting, creative assignments
  - **Single parse pattern**: Client code can use the same parsing logic for both operations
  - **Atomic state view**: Buyers see exactly what was created/modified without follow-up calls
  - **Modification transparency**: If publisher adjusted budget or other fields, buyer sees actual values immediately

  **Backward Compatibility:**

  - **Additive change only**: New fields added to create_media_buy response
  - **Existing fields unchanged**: media_buy_id, buyer_ref, creative_deadline, packages array all remain
  - **Non-breaking**: Clients parsing just package_id and buyer_ref will continue to work
  - **Dual ID support maintained**: Both publisher IDs (media_buy_id, package_id) and buyer refs are included

  **Response Structure:**

  ```json
  {
    "media_buy_id": "mb_12345",
    "buyer_ref": "campaign_ref",
    "creative_deadline": "2024-01-30T23:59:59Z",
    "packages": [
      {
        "package_id": "pkg_001",
        "buyer_ref": "package_ref",
        "product_id": "ctv_premium",
        "budget": 50000,
        "status": "active",
        "pacing": "even",
        "pricing_option_id": "cpm-fixed",
        "creative_assignments": [],
        "format_ids_to_provide": [...]
      }
    ]
  }
  ```

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

- e56721c: Consolidate and rename enum types to eliminate naming collisions

  ## Problem

  Type generators (Python, TypeScript, Go) produced collisions when the same enum name appeared in different schemas:

  - `AssetType` collided across 3 different schemas with overlapping value sets
  - `Type` field name used for both asset content types and format categories
  - Filtering contexts used incomplete subsets rather than full enum

  This caused downstream issues:

  - Python codegen exported first-alphabetically enum, hiding others
  - TypeScript generators produced `Type1`, `Type2` aliases
  - Developers needed internal imports to access correct types

  ## Changes

  **New enum files**:

  - `/schemas/v1/enums/asset-content-type.json` - Asset content types (image, video, html, javascript, vast, daast, text, markdown, css, url, webhook, promoted_offerings, audio)
  - `/schemas/v1/enums/format-category.json` - Format categories (audio, video, display, native, dooh, rich_media, universal)

  **Removed**:

  - `/schemas/v1/core/asset-type.json` - Orphaned schema (never referenced). Originally intended for format requirements but superseded by inline asset definitions in format.json. The enum values from this schema informed the new asset-content-type.json enum.

  **Updated schemas**:

  - `format.json`: `type` field now references `format-category.json`
  - `format.json`: `asset_type` fields now reference `asset-content-type.json`
  - `list-creative-formats-request.json`: All filter fields now use full enum references (no more artificial subsets)
  - `brand-manifest.json`: `asset_type` now references full enum with documentation note about typical usage

  ## Wire Protocol Impact

  **None** - This change only affects schema organization and type generation. The JSON wire format is unchanged, so all API calls remain compatible.

  ## SDK/Type Generation Impact

  **Python**: Update imports from internal generated modules to stable exports:

  ```python
  # Before
  from adcp.types.stable import AssetType  # Actually got asset content types
  from adcp.types.generated_poc.format import Type as FormatType  # Had to alias

  # After
  from adcp.types.stable import AssetContentType, FormatCategory
  ```

  **TypeScript**: Update type imports:

  ```typescript
  // Before
  import { AssetType, Type } from "./generated/types"; // Ambiguous

  // After
  import { AssetContentType, FormatCategory } from "./generated/types"; // Clear
  ```

  **Schema references**: If you're implementing validators, update `$ref` paths:

  ```json
  // Before
  { "type": "string", "enum": ["image", "video", ...] }

  // After
  { "$ref": "/schemas/v1/enums/asset-content-type.json" }
  ```

  ## Rationale

  - **Type safety**: Generators produce clear, non-colliding type names
  - **API flexibility**: Filters now accept full enum (no artificial restrictions)
  - **Maintainability**: Single source of truth for each concept
  - **Clarity**: Semantic names (`AssetContentType` vs `FormatCategory`) self-document

  ## Spec Policy

  Going forward, AdCP follows strict enum naming rules documented in `/docs/spec-guidelines.md`:

  - No reused enum names across different schemas
  - Use semantic, domain-specific names
  - Consolidate enums rather than creating subsets
  - All enums in `/schemas/v1/enums/` directory

- 4bf2874: Application-Level Context in Task Payloads

  - Task request schemas now accept an optional `context` object provided by the initiator
  - Task response payloads (and webhook `result` payloads) echo the same `context`

- e5802dd: Add explicit `is_fixed` discriminator field to all pricing option schemas for consistent discrimination.

  **What Changed:**

  - Fixed-rate options (CPM, vCPM, CPC, CPV, CPCV, CPP, Flat Rate): Now include `is_fixed: true` as a required field
  - Auction-based options (CPM Auction, vCPM Auction): Now include `is_fixed: false` as a required field

  **Why This Change:**
  Previously, only `flat-rate-option` had an explicit `is_fixed` field. Other pricing options had inconsistent discrimination:

  - CPM Fixed vs CPM Auction: Both used `pricing_model: "cpm"`, differentiated only by presence of `rate` vs `price_guidance`
  - vCPM Fixed vs vCPM Auction: Both used `pricing_model: "vcpm"`, same structural inference issue

  This created two different discrimination patterns (explicit field-based vs structural inference), making it difficult for TypeScript generators and clients to properly discriminate between fixed and auction pricing.

  **Benefits:**

  - **Consistent discrimination**: All pricing options use the same explicit pattern
  - **Type safety**: Discriminated unions work properly with `is_fixed` as discriminator
  - **Client simplicity**: No need to check for `rate` vs `price_guidance` existence
  - **API clarity**: Explicit is always better than implicit
  - **Forward compatibility**: Adding new pricing models is easier with explicit discrimination

  **Migration Guide:**
  All pricing option objects must now include the `is_fixed` field:

  ```json
  // Fixed-rate pricing (CPM, vCPM, CPC, CPV, CPCV, CPP, Flat Rate)
  {
    "pricing_option_id": "cpm_usd_guaranteed",
    "pricing_model": "cpm",
    "is_fixed": true,
    "rate": 5.50,
    "currency": "USD"
  }

  // Auction pricing (CPM Auction, vCPM Auction)
  {
    "pricing_option_id": "cpm_usd_auction",
    "pricing_model": "cpm",
    "is_fixed": false,
    "price_guidance": {
      "floor": 2.00
    },
    "currency": "USD"
  }
  ```

- 881ffbf: Remove unused legacy fields from list_creatives response schema.

  **Fields removed:**

  - `media_url` - URL of the creative file
  - `click_url` - Landing page URL
  - `duration` - Duration in milliseconds
  - `width` - Width in pixels
  - `height` - Height in pixels

  **Why this is a minor change (not breaking):**

  These fields were never implemented or populated by any AdCP server implementation. They existed in the schema from the initial creative library implementation but were non-functional. All creative metadata is accessed through the structured `assets` dictionary, which has been the only working approach since AdCP v2.0.

  **Migration:**

  No migration needed - if you were parsing these fields, they were always empty/null. Use the `assets` dictionary to access creative properties:

  ```json
  {
    "creative_id": "hero_video_30s",
    "assets": {
      "vast": {
        "url": "https://vast.example.com/video/123",
        "vast_version": "4.1"
      }
    }
  }
  ```

  All creative asset metadata (URLs, dimensions, durations, click destinations) is contained within the typed asset objects in the `assets` dictionary.

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

- 75d12c3: Simplify BrandManifest Schema

  - Replace `anyOf` constraint with single `required: ["name"]` field
  - Fixes code generation issue where schema generators created duplicate types (BrandManifest1 | BrandManifest2)
  - Brand name is now always required, URL remains optional
  - Supports both URL-based brands and white-label brands without URLs

- b7745a4: - Standardize webhook payload: protocol envelope at top-level; task-specific data moved under result.
  - Result schema is bound to task_type via JSON Schema refs; result MAY be present for any status (including failed).
  - Error remains a string; can appear alongside result.
  - Required fields updated to: task_id, task_type, status, timestamp. Domain is no longer required.
  - Docs updated to reflect envelope + result model.
  - Compatibility: non-breaking for users of adcp/client (already expects result); breaking for direct webhook consumers that parsed task fields at the root.
- efc90f2: Add testable documentation infrastructure and improve library discoverability

  **Library Discoverability:**

  - Added prominent "Client Libraries" section to intro.mdx with NPM badge and installation links
  - Updated README.md with NPM package badge and client library installation instructions
  - Documented Python client development status (in development, use MCP SDK directly)
  - Added links to NPM package, PyPI (future), and GitHub repositories

  **Documentation Snippet Testing:**

  - Created comprehensive snippet validation test suite (`tests/snippet-validation.test.js`)
  - Extracts code blocks from all documentation files (.md and .mdx)
  - Tests JavaScript, TypeScript, Python, and Bash (curl) examples
  - Snippets marked with `test=true` or `testable` are automatically validated
  - Integration with test suite via `npm run test:snippets` and `npm run test:all`
  - Added contributor guide for writing testable documentation snippets

  **What this enables:**

  - Documentation examples stay synchronized with protocol changes
  - Broken examples are caught in CI before merging
  - Contributors can confidently update examples knowing they'll be tested
  - Users can trust that documentation code actually works

  **For contributors:**
  See `docs/contributing/testable-snippets.md` for how to write testable documentation examples.

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

- 7b2ebd4: Complete consolidation of ALL inline enum definitions into /schemas/v1/enums/ directory for consistency and maintainability.

  **New enum schemas created (31 total):**

  _Video/Audio Ad Serving:_

  - `vast-version.json`, `vast-tracking-event.json` - VAST specs
  - `daast-version.json`, `daast-tracking-event.json` - DAAST specs

  _Core Protocol:_

  - `adcp-domain.json` - Protocol domains (media-buy, signals)
  - `property-type.json` - Property types (website, mobile_app, ctv_app, dooh, etc.)
  - `dimension-unit.json` - Dimension units (px, dp, inches, cm)

  _Creative Policies & Requirements:_

  - `co-branding-requirement.json`, `landing-page-requirement.json` - Creative policies
  - `creative-action.json` - Creative lifecycle
  - `validation-mode.json` - Creative validation strictness

  _Asset Types:_

  - `javascript-module-type.json`, `markdown-flavor.json`, `url-asset-type.json`
  - `http-method.json`, `webhook-response-type.json`, `webhook-security-method.json`

  _Performance & Reporting:_

  - `metric-type.json`, `feedback-source.json` - Performance feedback
  - `reporting-frequency.json`, `available-metric.json` - Delivery reports
  - `notification-type.json` - Delivery notifications

  _Signals & Discovery:_

  - `signal-catalog-type.json` - Signal catalog types
  - `creative-agent-capability.json` - Creative agent capabilities
  - `preview-output-format.json` - Preview formats

  _Brand & Catalog:_

  - `feed-format.json`, `update-frequency.json` - Product catalogs
  - `auth-scheme.json` - Push notification auth

  _UI & Sorting:_

  - `sort-direction.json`, `creative-sort-field.json`, `history-entry-type.json`

  **Schemas updated (25+ files):**

  _High-impact (eliminated duplication):_

  - `vast-asset.json`, `daast-asset.json` - Removed duplicate enum definitions
  - `performance-feedback.json`, `provide-performance-feedback-request.json` - Unified metrics/sources
  - `signals/get-signals-request.json`, `signals/get-signals-response.json` - Unified catalog types
  - `list-creative-formats-response.json` (2 files) - Unified capabilities
  - `preview-creative-request.json` - Unified output formats (3 occurrences)

  _Asset schemas:_

  - `webhook-asset.json`, `javascript-asset.json`, `markdown-asset.json`, `url-asset.json`

  _Core schemas:_

  - `property.json`, `format.json`, `creative-policy.json`
  - `reporting-capabilities.json`, `push-notification-config.json`, `webhook-payload.json`

  _Task schemas:_

  - `sync-creatives-request.json`, `sync-creatives-response.json`
  - `list-creatives-request.json`, `list-creatives-response.json`
  - `get-media-buy-delivery-request.json`, `get-products-request.json`
  - Various task list/history schemas

  **Documentation improvements:**

  - Added comprehensive enum versioning strategy to CLAUDE.md
  - Clarifies when enum changes are MINOR vs MAJOR version bumps
  - Documents best practices for enum evolution (add → deprecate → remove)
  - Provides examples of proper enum deprecation workflows

  **Registry update:**

  - Added all 31 new enums to `index.json` with descriptions

  **Impact:**

  - **Enum files**: 16 → 46 (31 new enums)
  - **Schemas validated**: 112 → 137 (25 new enum files)
  - **Duplication eliminated**: 8+ instances across schemas
  - **Single source of truth**: All enums now centralized

  **Benefits:**

  - Complete consistency across all schemas
  - Eliminates all inline enum duplication
  - Easier to discover and update enum values
  - Better SDK generation from consolidated enums
  - Clear guidance for maintaining backward compatibility
  - Follows JSON Schema best practices

- 0504fcf: Extract duplicated property ID and tag patterns into reusable core schemas.

  **New schemas:**

  - `property-id.json` - Single source of truth for property identifier validation
  - `property-tag.json` - Single source of truth for property tag validation

  **Updated schemas:**

  - `publisher-property-selector.json` - Now references shared property-id and property-tag schemas
  - `adagents.json` - Now references shared property-id and property-tag schemas
  - `property.json` - Now references shared property-id and property-tag schemas for property_id and tags fields

  **Benefits:**

  - Eliminates inline pattern duplication across multiple schemas
  - SDK generators now produce single types for property IDs and tags instead of multiple incompatible types
  - Single source of truth for validation rules - changes apply everywhere
  - Clearer semantic meaning with explicit type names
  - Easier to maintain and evolve constraints in the future

  **Breaking change:** No - validation behavior is identical, this is a refactoring only.

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
- 17382ac: Extract filter objects into separate schema files for better type generation.

  **Schema Changes:**

  - Created `product-filters.json` core schema for `get_products` filters
  - Created `creative-filters.json` core schema for `list_creatives` filters
  - Created `signal-filters.json` core schema for `get_signals` filters
  - Updated request schemas to use `$ref` instead of inline filter definitions

  **Benefits:**

  - Type generators can now create proper `ProductFilters`, `CreativeFilters`, and `SignalFilters` classes
  - Enables direct object instantiation: `GetProductsRequest(filters=ProductFilters(delivery_type="guaranteed"))`
  - Better IDE autocomplete and type checking for filter parameters
  - Single source of truth for each filter type
  - Consistent with other AdCP core object patterns

  **Migration:**
  No breaking changes - filter structures remain identical, just moved to separate schema files. Existing code continues to work without modification.

- 8d2bfbb: Fix provide_performance_feedback to support buyer_ref identifier

  The provide_performance_feedback request schema now accepts either `media_buy_id` or `buyer_ref` to identify the media buy, matching the pattern used in update_media_buy and other operations. This was the only schema in the entire specification that forced buyers to track publisher-assigned IDs, creating an inconsistency.

  **What changed:**

  - Added `buyer_ref` field to provide-performance-feedback-request.json
  - Changed `required` array to `oneOf` pattern allowing either identifier
  - Buyers can now provide feedback using their own reference instead of having to track the publisher's media_buy_id

  **Impact:**

  - Backward compatible - existing calls using media_buy_id continue to work
  - Removes the only forced ID tracking requirement in the buyer workflow
  - Aligns with the principle that buyers use their own references throughout

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

- dfaeece: Refactor publisher property selector schemas to eliminate duplication. Created shared `publisher-property-selector.json` core schema that is now referenced by both `product.json` and `adagents.json` via `$ref`, replacing duplicated inline definitions.

  **Technical improvement**: No API or behavior changes. This is a pure schema refactoring that maintains identical validation semantics while improving maintainability and TypeScript code generation.

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

- ead19fa: Restore Offline File Delivery (Batch) section and update pre-push validation to use Mintlify.

  Restored the "Offline File Delivery (Batch)" section that was removed in PR #203 due to MDX parsing errors. The section now uses regular markdown sections instead of tabs to avoid MDX parsing issues.

  **Changes:**

  - Restored comprehensive format examples for JSONL, CSV, and Parquet formats
  - Fixed empty space issue at `#offline-file-delivery-batch` anchor
  - Reordered the Delivery Methods section to make the structure more reasonable - Delivery Methods is now the parent section with Webhook-Based Reporting and Offline-File-Delivery-Based Reporting as subsections
  - Updated pre-push hook to validate with Mintlify (broken links and accessibility checks) instead of Docusaurus build
  - Aligned validation with production system (Mintlify)
  - Added missing fields (notification_type, sequence_number, next_expected_at) to all offline file format examples
  - Updated CSV format to use dot notation (by_package.pricing_model, totals.impressions)

  This ensures the documentation section works correctly in production and prevents future removals due to syntax conflicts between Docusaurus and Mintlify.

- b32275d: Fix: Rename `destinations` field to `deployments` in all signal request schemas for terminology consistency.

  This change standardizes the field name to use "deployments" throughout both requests and responses, creating a simpler mental model where everything uses consistent "deployment" terminology.

  **What changed:**

  - `get_signals` request: `deliver_to.destinations` → `deliver_to.deployments`
  - `activate_signal` request: `destinations` → `deployments`

  **Migration guide:**

  **Before:**

  ```json
  {
    "signal_spec": "High-income households",
    "deliver_to": {
      "destinations": [
        {
          "type": "platform",
          "platform": "the-trade-desk"
        }
      ],
      "countries": ["US"]
    }
  }
  ```

  **After:**

  ```json
  {
    "signal_spec": "High-income households",
    "deliver_to": {
      "deployments": [
        {
          "type": "platform",
          "platform": "the-trade-desk"
        }
      ],
      "countries": ["US"]
    }
  }
  ```

  The `Destination` schema itself remains unchanged - only the field name in requests has been renamed to match the response field name (`deployments`).

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
