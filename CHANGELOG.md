# Changelog

## 3.0.0-rc.1

### Major Changes

- 892da1d: Delete brand-manifest.json. The brand object in brand.json is now the single
  canonical brand definition. Task schemas reference brands by domain + brand_id
  instead of passing inline manifests. Brand data is always resolved from
  brand.json or the registry.
- 5b8feea: **BREAKING**: Rename `catalog` to `catalogs` (array) on creative manifest. Formats can declare multiple catalog_requirements (e.g., product + inventory + store); the manifest now supports multiple catalogs to match. Each catalog's `type` maps to the corresponding catalog_requirements entry.
- 7cf7476: Remove `estimated_exposures` from Product, replace with optional `forecast`

  - Remove the unitless `estimated_exposures` integer field from the Product schema
  - Add optional `forecast` field using the existing `DeliveryForecast` type, giving buyers structured delivery estimates with time periods, metric ranges, and methodology context during product discovery

- 811bd0e: Redesign `refine` as a typed change-request array with seller acknowledgment

  The `refine` field is now an array of change requests, each with a `scope` discriminator (`request`, `product`, or `proposal`) and an `ask` field describing what the buyer wants. The seller responds via `refinement_applied` — a positionally-matched array reporting whether each ask was `applied`, `partial`, or `unable`. This replaces the previous object structure with separate `overall`, `products`, and `proposals` fields.

- 544230b: Address schema gaps that block autonomous agent operation, plus consistency fixes.

  **Error handling (#1223)**

  - `Error`: add `recovery` field (`transient | correctable | terminal`) so agents can classify failures without escalating every error to humans
  - New `enums/error-code.json`: standard vocabulary (`RATE_LIMITED`, `SERVICE_UNAVAILABLE`, `PRODUCT_UNAVAILABLE`, `PROPOSAL_EXPIRED`, `BUDGET_TOO_LOW`, `CREATIVE_REJECTED`, `UNSUPPORTED_FEATURE`, `AUDIENCE_TOO_SMALL`, `ACCOUNT_NOT_FOUND`, `ACCOUNT_PAYMENT_REQUIRED`, `ACCOUNT_SUSPENDED`)

  **Idempotency (#1224)**

  - `UpdateMediaBuyRequest`, `SyncCreativesRequest`: add `idempotency_key` for safe retries after timeouts
  - `CreateMediaBuyRequest.buyer_ref`: document deduplication semantics (buyer_ref is the idempotency key for create)

  **Media buy lifecycle (#1225)**

  - `MediaBuyStatus`: add `rejected` enum value for post-creation seller declines
  - `MediaBuy`: add `rejection_reason` field present when `status === rejected`

  **Protocol version (#1226)**

  - `GetAdCPCapabilitiesResponse.adcp.major_versions`: document version negotiation via capabilities handshake; HTTP header is optional

  **Async polling (#1227)**

  - `GetAdCPCapabilitiesResponse.adcp`: add `polling` object (`supported`, `recommended_interval_seconds`, `max_wait_seconds`) for agents without persistent webhook endpoints

  **Package response (#1229)**

  - `Package`: add `catalogs` (array) and `format_ids` fields echoed from the create request so agents can verify what the seller stored

  **Signal deactivation (#1231)**

  - `ActivateSignalRequest`: add `action: activate | deactivate` field with `activate` default; deactivation removes segments from downstream platforms to support GDPR/CCPA compliance

  **Signal metadata (#1232)**

  - `GetSignalsResponse` signal entries: add `categories` (for `categorical` signals) and `range` (for `numeric` signals) so buyers can construct valid targeting values

  **Property list filters (#1233)**

  - `PropertyListFilters`: make `countries_all` and `channels_any` optional; omitting means no restriction (enables global lists and all-channel lists)

  **Content standards response (#1234)**

  - `UpdateContentStandardsResponse`: replace flat object with `UpdateContentStandardsSuccess | UpdateContentStandardsError` discriminated union (`success: true/false`) consistent with all other write operations

  **Product refinement (#1235)**

  - `GetProductsRequest`: add `buying_mode: "refine"` with `refine` array of typed change requests — each entry declares a `scope` (`request`, `product`, or `proposal`) with an `ask` field. `GetProductsResponse`: add `refinement_applied` array where the seller acknowledges each ask by position (`applied`, `partial`, or `unable`)

  **Creative assignments (#1237)**

  - `SyncCreativesRequest.assignments`: replace ambiguous `{ creative_id: package_id[] }` map with typed array `{ creative_id, package_id, weight?, placement_ids? }[]`

  **Batch preview (#1238)**

  - `PreviewBatchResultSuccess`: add required `success: true`, `creative_id`, proper `response` object with `previews` and `expires_at`
  - `PreviewBatchResultError`: add required `success: false`, `creative_id`, `errors: Error[]` (referencing standard Error schema)

  **Creative delivery pagination (#1239)**

  - `GetCreativeDeliveryRequest.pagination`: replace ad-hoc `limit/offset` with standard `PaginationRequest` cursor-based pagination

  **Signals account consistency (#1242)**

  - `GetSignalsRequest`, `ActivateSignalRequest`: replace `account_id: string` with `account: $ref account-ref.json` for consistency with all other endpoints

  **Signals field naming (#1244)**

  - `ActivateSignalRequest`: rename `deployments` to `destinations` for consistency with `GetSignalsRequest`

  **Creative features billing (#1245)**

  - `GetCreativeFeaturesRequest`: add optional `account` field for governance agents that charge per evaluation

  **Consent basis enum (#1246)**

  - New `enums/consent-basis.json`: extract inline GDPR consent basis enum to shared schema

  **Date range extraction (#1247)**

  - New `core/date-range.json` and `core/datetime-range.json`: extract duplicated inline period objects from financials, usage, and feedback schemas

  **Creative features clarity (#1248)**

  - `GetCreativeFeaturesRequest`/`Response`: clarify description to make evaluation semantics explicit

  **Remove non-standard keyword (#1250)**

  - `SyncAudiencesRequest`: remove ajv-specific `errorMessage` keyword that violates JSON Schema draft-07

  **Package catalogs**

  - `Package`, `PackageRequest`: change `catalog` (single) to `catalogs` (array) to support multi-catalog packages (e.g., product + store catalogs)

  **Error code vocabulary expansion (#1269–1276)**

  - `ErrorCode`: add `BUDGET_EXHAUSTED` (account/campaign budget spent, distinct from `BUDGET_TOO_LOW`) and `CONFLICT` (concurrent modification)
  - `Error.code`: stays `type: string` (not wired to enum) so sellers can use platform-specific codes; description references error-code.json as the standard vocabulary

  **Frequency cap semantics (#1272)**

  - `FrequencyCap`: add normative AND semantics — when both `suppress` and `max_impressions` are set, an impression is delivered only if both constraints permit it

  **Catalog uniqueness (#1276)**

  - `Package`, `PackageRequest`: strengthen catalog type uniqueness from SHOULD to MUST; sellers MUST reject duplicates with `validation_error`

  **Creative weight semantics**

  - `CreativeAssignment`, `SyncCreativesRequest.assignments`: clarify weight is relative proportional (weight 2 = 2x weight 1), omitted = equal rotation, 0 = assigned but paused

  **Outcome measurement window (breaking)**

  - `OutcomeMeasurement.window`: change from `type: string` (e.g., `"30_days"`) to `$ref: duration.json` (structured `{interval, unit}`)

  **Media buy lifecycle**

  - `MediaBuyStatus`: add `canceled` (buyer-initiated termination, distinct from `completed` and `rejected`)
  - `GetMediaBuyDeliveryResponse`: add `canceled` to inline status enum

- 4c33b99: Add required `buying_mode` discriminator to `get_products` request for explicit wholesale vs curated buying intent.

  Buyers with their own audience stacks (DMPs, CDPs, AXE integrations) can now set `buying_mode: "wholesale"` to declare they want raw inventory without publisher curation. Buyers using curated discovery set `buying_mode: "brief"` and include `brief`. This removes ambiguity from legacy requests that omitted `buying_mode`.

  When `buying_mode` is `"wholesale"`:

  - Publisher returns products supporting buyer-directed targeting
  - No AI curation or personalization is applied
  - No proposals are returned
  - `brief` must not be provided (mutually exclusive)

### Minor Changes

- f6336af: Serve AgenticAdvertising.org brand.json from hosted_brands database so it can be managed via Addie tools. Seed initial brand data including structured tone format with voice and attributes.
- a9e118d: Introduce Accounts Protocol documentation as a named cross-protocol section covering commercial infrastructure: `sync_accounts`, `list_accounts`, and `report_usage`. Includes Accounts Protocol overview connecting brand registry, account establishment, and settlement into a transaction lifecycle. Moves account management tasks from Media Buy Protocol to the new Accounts Protocol section.
- 142bcd5: Replace account_id with account reference, restructure account model.

  - Add `account-ref.json`: union type accepting `{ account_id }` or `{ brand, operator }`
  - Use `brand-ref.json` (domain + brand_id) instead of flat house + brand_id in account schemas
  - Make `operator` required everywhere (brand sets operator to its own domain when operating its own seat)
  - Add `account_resolution` capability (string: `explicit_account_id` or `implicit_from_sync`)
  - Simplify billing to `operator` or `agent` only (brand-as-operator when brand pays directly)
  - **Breaking**: `billing` is now required in `sync_accounts` request (previously optional). Existing callers that omit `billing` will receive validation errors. Billing is accept-or-reject — sellers cannot silently remap billing.
  - Make `account` required on create_media_buy, get_media_buys, sync_creatives, sync_catalogs, sync_audiences, sync_event_sources
  - Make `account` required per record on report_usage
  - `sync_accounts` no longer returns `account_id` — the seller manages account identifiers internally. Buyers discover IDs via `list_accounts` (explicit model) or use natural keys (implicit model).
  - Make `account_id` required in `account.json` (remove conditional if/then — the schema is only used in seller responses where the seller always has an ID)
  - Add `account_scope` to account and sync_accounts response schemas
  - Add `ACCOUNT_SETUP_REQUIRED` and `ACCOUNT_AMBIGUOUS` error codes
  - Add `get_account_financials` task for operator-billed account financial status

- ff62171: Add `app` catalog type for mobile app install and re-engagement advertising.

  Introduces `AppItem` schema with fields for `bundle_id`, `apple_id`, `platform` (ios/android), store metadata, and deep links. Maps to Google App Campaigns, Apple Search Ads, Meta App Ads, TikTok App Campaigns, and Snapchat App Install Ads.

  Also adds `app_id` to `content-id-type` for conversion event matching and `APP_ITEM_ID` to universal macros for tracking URL substitution.

- 8ec2ab3: Add `external_id` field to AudienceMember for buyer-assigned stable identifiers (CRM record ID, loyalty ID). Remove `external_id` from uid-type enum — it was not a universal ID and belongs as a dedicated field. Add `external_id` to `supported_identifier_types` in capabilities so sellers can advertise support.
- ce439ca: Brand registry lookup, unified enrichment, and membership inheritance
- c872c94: Brand registry as primary company identity source. Member profiles now link to the brand registry via `primary_brand_domain` instead of storing logos and colors directly. Members set up their brand through the brand tools and get a hosted brand.json at `agenticadvertising.org/brands/yourdomain.com/brand.json`. Placing a one-line pointer at `/.well-known/brand.json` makes AgenticAdvertising.org the authoritative brand source for any domain.
- 1051929: Add optional `campaign_ref` field to `get_products` and `create_media_buy` for grouping related operations under a buyer-defined campaign label. Echoed in media buy responses for CRM and ad server correlation.
- 15a64e6: Refactor `CatalogFieldBinding` schema to use a `kind` discriminator field (`"scalar"`, `"asset_pool"`, `"catalog_group"`) instead of `allOf + oneOf` with negative `not` constraints. Scalar and asset pool variants are extracted to `definitions` for reuse in `per_item_bindings`. Generates a clean TypeScript discriminated union instead of triplicated intersections.
- 5b8feea: Add catalog item macros for item-level attribution: SKU, GTIN, OFFERING_ID, JOB_ID, HOTEL_ID, FLIGHT_ID, VEHICLE_ID, LISTING_ID, STORE_ID, PROGRAM_ID, and DESTINATION_ID (mirroring the content_id_type enum), plus CATALOG_ID for catalog-level attribution and CREATIVE_VARIANT_ID for seller-assigned creative variant tracking. Enables closed-loop attribution from impression tracking through conversion events.
- e2e68d3: Add typed catalog assets, field bindings, and feed field mappings.

  **Typed assets on vertical catalog items**: `hotel`, `flight`, `job`, `vehicle`, `real_estate`, `education`, `destination`, and `app` item schemas now support an `assets` array using `OfferingAssetGroup` structure. Enables buyers to provide typed image pools (`images_landscape`, `images_vertical`, `logo`, etc.) alongside existing scalar fields, so formats can declare which asset group to use for each platform-specific slot rather than relying on a single `image_url`.

  **Field bindings on format catalog requirements**: `catalog_requirements` entries now support `field_bindings` — explicit mappings from format template slots (`asset_id`) to catalog item fields (dot-notation path) or typed asset pools (`asset_group_id`). Supports scalar field binding, asset pool binding, and repeatable group iteration over catalog items. Optional — agents can still infer without bindings.

  **Feed field mappings on catalog**: The `Catalog` object now accepts `feed_field_mappings` for normalizing external feeds during `sync_catalogs` ingestion. Supports field renames, named transforms (`date`, `divide`, `boolean`, `split`) with per-transform parameters, static literal injection, and placement of image URLs into typed asset pools. Eliminates the need to preprocess every non-AdCP feed before syncing.

- cc41e01: Add compliance fields to creative-brief schema. Unify manifest to format_id + assets.

  Add optional `compliance` object to `creative-brief.json` with `required_disclosures` (structured array with text, position, jurisdictions, regulation, min_duration_ms, and language) and `prohibited_claims` (string array). Disclosures support per-jurisdiction requirements via ISO 3166-1/3166-2 codes (country or subdivision). Extract disclosure position to shared `disclosure-position.json` enum with values: prominent, footer, audio, subtitle, overlay, end_card, pre_roll, companion. Creative agents that cannot satisfy a required disclosure MUST fail the request.

  Move `creative_brief` and `catalogs` from top-level manifest fields to proper asset types (`brief` and `catalog`) within the `assets` map. Add `"brief"` and `"catalog"` to the asset-content-type enum. Create `brief-asset.json` and `catalog-asset.json` schemas. Move format-level `catalog_requirements` into the catalog asset's `requirements` field within the format's `assets` array. Add `max_items` to `catalog-requirements.json`. The manifest is now `format_id` + `assets`.

  Add `supported_disclosure_positions` to `format.json` so formats declare which disclosure positions they can render.

  Remove `creative_brief` from `build-creative-request.json` and delete `creative-brief-ref.json`. Remove `supports_brief` capability flag.

  Note: `creative_brief` on manifests, `catalog_requirements` on formats, `creative-brief-ref.json`, and `supports_brief` were added during this beta cycle and never released, so these structural changes are not breaking.

- 5622c51: Add build capability discovery to creative formats.

  `format.json` gains `input_format_ids` — the source creative formats a format accepts as input manifests (alongside the existing `output_format_ids` for what can be produced).

  `list_creative_formats` gains two new filter parameters:

  - `output_format_ids` — filter to formats that can produce any of the specified outputs
  - `input_format_ids` — filter to formats that accept any of the specified formats as input

  Together these let agents ask a creative agent "what can you build?" and query in either direction: "given outputs I need, what inputs do you accept?" or "given inputs I have, what outputs can you produce?"

- 7b1d51e: Add `get_creative_features` task for creative governance

  Introduces the creative analog of `get_property_features` — a general-purpose task for evaluating creatives and returning feature values. Supports security scanning, creative quality assessment, content categorization, and any other creative evaluation through the same feature-based pattern used by property governance.

  New schemas:

  - `get-creative-features-request.json` — accepts a creative manifest and optional feature_ids filter
  - `get-creative-features-response.json` — returns feature results with discriminated union (success/error)
  - `creative-feature-result.json` — individual feature evaluation (value, confidence, expires_at, etc.)

  Also adds `creative_features` to the governance section of `get_adcp_capabilities` response, allowing agents to advertise which creative features they can evaluate.

- 9652531: Add dimension breakdowns to delivery reporting and device_type targeting.

  New enums: `device-type.json` (desktop, mobile, tablet, ctv, dooh, unknown), `audience-source.json` (synced, platform, third*party, lookalike, retargeting, unknown), `sort-metric.json` (sortable numeric delivery-metrics fields). New shared schema: `geo-breakdown-support.json` for declaring geographic breakdown capabilities. Add `device_type` and `device_type_exclude` to targeting overlay. Add `reporting_dimensions` request parameter to `get_media_buy_delivery` for opting into geo, device_type, device_platform, audience, and placement breakdowns with configurable sort and limit. Add corresponding `by*\*`arrays with truncation flags to the delivery response under`by_package`. Declare breakdown support in `reporting_capabilities`(product-level). Add`device_type`to seller-level targeting capabilities in`get_adcp_capabilities`.

  Note: the speculative `by_geography` example in docs (never in the schema or spec) has been replaced with the formal `by_geo` structure.

- 5289d34: Add 3-tier event visibility: public, invite-only listed, and invite-only unlisted. Invite-only events support explicit email invite lists and rule-based access (membership required, org allow-list). Adds `interested` as a distinct registration status for non-invited users who express interest.
- ca18472: Flatten `deliver_to` in `get_signals` request into top-level `destinations` and `countries` fields.

  Previously, callers were required to construct a nested `deliver_to` object with `deployments` and `countries` sub-fields, even when querying a platform's own signal agent where the destination is implicit. Both fields are now optional top-level parameters:

  - `destinations`: Filter signals to those activatable on specific agents/platforms. When omitted, returns all signals available on the current agent.
  - `countries`: Geographic filter for signal availability.

- 1590905: Add `geo_proximity` targeting for arbitrary-location proximity targeting. Three methods: travel time isochrones (e.g., "within 2hr drive of Düsseldorf"), simple radius (e.g., "within 30km of Heathrow"), and pre-computed GeoJSON geometry (buyer provides the polygon). Structured capability declaration in `get_adcp_capabilities` allows sellers to declare supported methods and transport modes independently.
- cb5af61: Add `get_media_buys` task for operational campaign monitoring. Returns current media buy status, creative approval state per package, missing format IDs, and optional near-real-time delivery snapshots with `staleness_seconds` to indicate data freshness. Complements `get_media_buy_delivery` which is for authoritative reporting over date ranges.
- daff9a2: Make `account` optional in `get_media_buys` request — when omitted, returns data across all accessible accounts. Add backward-compatibility clause to `get_products`: sellers receiving requests from pre-v3 clients without `buying_mode` should default to `"brief"`.
- 13919b5: Add keyword targeting for search and retail media platforms.

  New fields in `targeting_overlay`:

  - `keyword_targets` — array of `{keyword, match_type, bid_price?}` objects for search/retail media targeting. Per-keyword `bid_price` overrides the package-level bid for that keyword and inherits `max_bid` interpretation from the pricing option. Keywords identified by `(keyword, match_type)` tuple.
  - `negative_keywords` — array of `{keyword, match_type}` objects to exclude matching queries from delivery.

  New fields in `package-update` (incremental operations):

  - `keyword_targets_add` — upsert keyword targets by `(keyword, match_type)` identity; adds new keywords or updates `bid_price` on existing ones
  - `keyword_targets_remove` — remove keyword targets by `(keyword, match_type)` identity
  - `negative_keywords_add` — append negative keywords to a live package without replacing the existing list
  - `negative_keywords_remove` — remove specific negative keyword+match_type pairs from a live package

  New field in delivery reporting (`by_package`):

  - `by_keyword` — keyword-grain breakdown with one row per `(keyword, match_type)` pair and standard delivery metrics

  New capability flags in `get_adcp_capabilities`:

  - `execution.targeting.keyword_targets`
  - `execution.targeting.negative_keywords`

  New reporting capability:

  - `reporting_capabilities.supports_keyword_breakdown`

- c782f66: Note: These changes are breaking relative to earlier betas but no fields removed here were ever in a stable release.

  Add `sync_catalogs` task and unified `Catalog` model. Replace separate `offerings[]` and `product_selectors` fields on `PromotedOfferings` with a typed `Catalog` object that supports inline items, external URL references, and platform-synced catalogs. Expand catalog types beyond offerings and product to include inventory, store, and promotion feeds. Add `sync_catalogs` task with request/response schemas, async response patterns (working, input-required, submitted), per-catalog approval workflow, and item-level review status. Add `catalog_requirements` on `Format` so formats can declare what catalog feeds they need and what fields each must provide. Add `OfferingAssetGroup` schema for structured per-offering creative pools, `OfferingAssetConstraint` for format-level asset requirements, and `geo_targets` on `Offering` for location-specific offerings. Add `account-state` conceptual doc framing Account as the central stateful container in AdCP 3.0. Rename promoted-offerings doc to catalogs to reflect its expanded scope. Add `StoreItem` schema for physical locations within store-type catalogs, with lat/lng coordinates, structured address, operating hours, and tags. Add `Catchment` schema for defining store catchment areas via three methods: isochrone inputs (travel time + transport mode), simple radius, or pre-computed GeoJSON geometry. Add `transport-mode` and `distance-unit` enums. Add industry-vertical catalog types (`hotel`, `flight`, `job`, `vehicle`, `real_estate`, `education`, `destination`) with canonical item schemas for each, drawn from Google Ads, Meta, LinkedIn, and Microsoft platform feed specs. Add shared `Price` schema. Add `linkedin_jobs` feed format. Remove `PromotedOfferings` wrapper — catalogs are now first-class. Creatives reference catalogs via `catalog` field instead of embedding in assets. Remove `promoted_offering` from media-buy and creative-manifest schemas. Add `conversion_events` and `content_id_type` to Catalog for conversion attribution. Rename catalog type `offerings` to `offering` for consistency with other singular type names. Remove `portfolio_ref` from Offering — structured `assets` (OfferingAssetGroup) replaces external portfolio references. Replace `product_selectors` (PromotedProducts) on `get_products` with `catalog` ($ref catalog.json) — one concept, one schema. Delete `promoted-products.json`. Add `catalog_types` to Product so products declare what catalog types they support. Add `matched_ids` and `matched_count` to `catalog_match`, remove `matched_skus`. Add `catalog` field to `package-request` and `package-update` for catalog-driven packages. Add `store_catchments` targeting dimension referencing synced store catalogs. Add `by_catalog_item` delivery breakdown in `get_media_buy_delivery` response for per-item reporting on catalog-driven packages. Update `creative-variant` description to clarify that catalog items rendered as ads are variants.

- 0e96a78: Add capability declarations for metric optimization goals, cross-channel engagement metrics, video view duration control, and value optimization.

  **New metric kinds** (`optimization_goals` with `kind: 'metric'`):

  - `engagements` — direct ad interaction beyond viewing: social reactions/comments/shares, story/unit opens, interactive overlay taps on CTV, companion banner interactions on audio
  - `follows` — new followers, page likes, artist/podcast/channel subscribes
  - `saves` — saves, bookmarks, playlist adds, pins
  - `profile_visits` — visits to the brand's page, artist page, or channel

  **Video view duration control:**

  - `view_duration_seconds` on metric goals — minimum view duration (in seconds) that qualifies as a `completed_views` event (e.g., 2s, 6s, 15s). Sellers declare supported durations in `metric_optimization.supported_view_durations`. Sellers must reject unsupported values.

  **New event goal target kind:**

  - `maximize_value` — maximize total conversion value within budget without a specific ROAS ratio target. Steers spend toward higher-value conversions. Requires `value_field` on event sources.

  **Product schema additions:**

  - `metric_optimization` — declares which metric kinds a product can optimize for (`supported_metrics`), which view durations are available (`supported_view_durations`), and which target kinds are supported (`supported_targets`). Presence indicates support for `kind: 'metric'` goals without any conversion tracking setup.
  - `max_optimization_goals` — maximum number of goals a package can carry. Most social platforms accept only 1.

  **Product schema corrections:**

  - `conversion_tracking.supported_optimization_strategies` renamed to `conversion_tracking.supported_targets` for consistency with `metric_optimization.supported_targets`. Both fields answer the same question: "what can I put in `target.kind`?"
  - Target kind enum values aligned across product capabilities and optimization goal schemas. Product `supported_targets` values (`cost_per`, `threshold_rate`, `per_ad_spend`, `maximize_value`) now exactly match `target.kind` values on optimization goals — agents can do direct string comparison.
  - `conversion_tracking` description clarified to be for `kind: 'event'` goals only.

  **Delivery metrics additions:**

  - `engagements`, `follows`, `saves`, `profile_visits` count fields added to delivery-metrics.json so buyers can see performance against the new metric optimization goals.
  - `completed_views` description updated to acknowledge configurable view duration threshold.

  **Forecastable metrics additions:**

  - `engagements`, `follows`, `saves`, `profile_visits` added to forecastable-metric.json for forecast completeness.

  **Capabilities schema addition:**

  - `media_buy.conversion_tracking.multi_source_event_dedup` — declares whether the seller can deduplicate events across multiple sources. When absent or false, buyers should use a single event source per goal.

  **Optimization goal description clarifications:**

  - `event_sources` references the `multi_source_event_dedup` capability; explains first-source-wins fallback when dedup is unsupported.
  - `value_field` and `value_factor` clarified as seller obligations (not optional hints). The seller must use these for value extraction and aggregation. They are not passed to underlying platform APIs.

- 5b25ccd: Redesign optimization goals with multiple event sources, threshold rates, and attention metrics.

  - `optimization_goal` (singular) → `optimization_goals` (array) on packages
  - `OptimizationGoal` is a discriminated union on `kind`:
    - `kind: "event"` — optimize for advertiser-tracked conversion events via `event_sources` array of source-type pairs. Seller deduplicates by `event_id` across sources. Each entry can specify `value_field` and `value_factor` for value-based targets.
    - `kind: "metric"` — optimize for a seller-native delivery metric with optional `cost_per` or `threshold_rate` target
  - Target kinds: `cost_per` (cost per unit), `threshold_rate` (minimum per-impression value), `per_ad_spend` (return ratio on event values), `maximize_value` (maximize total conversion value)
  - Metric enum: `clicks`, `views`, `completed_views`, `viewed_seconds`, `attention_seconds`, `attention_score`, `engagements`, `follows`, `saves`, `profile_visits`
  - Both kinds support optional `priority` (integer, 1 = highest) for multi-goal packages
  - `product.conversion_tracking.supported_targets`: `cost_per`, `per_ad_spend`, `maximize_value`
  - `product.metric_optimization.supported_targets`: `cost_per`, `threshold_rate`

- e6767f2: Add `overlays` to format asset definitions for publisher-controlled elements that render over buyer content.

  Publishers can now declare video player controls, publisher logos, and similar per-asset chrome as `overlays` on individual assets. Each overlay includes `bounds` (pixel or fractional, relative to the asset's own top-left corner) and optional `visual` URLs for light and dark theme variants. Creative agents use this to avoid placing critical buyer content behind publisher chrome when composing creatives.

- dfcb522: Add structured pricing options to signals and content standards protocols.

  `get_signals` now returns `pricing_options` (array of typed pricing option objects) instead of the legacy `pricing: {cpm, currency}` field. This enables signals agents to offer time-based subscriptions, flat-rate, CPCV, and other pricing models alongside CPM.

  `list_content_standards` / `get_content_standards` now include `pricing_options` on content standards objects as an optional field, using the same structure. Full billing integration for governance agents will be defined when the account setup flow for that protocol is designed.

  `report_usage` has been simplified: `kind` and `operator_id` are removed. The receiving vendor agent already knows what type of service it provides, and the billing operator is captured by the account reference (`brand + operator` form or implied by account setup when using `account_id`).

  `report_usage` now accepts an `idempotency_key` field. Supply a client-generated UUID per request to prevent duplicate billing on retries.

  `activate_signal` now accepts `pricing_option_id`. Pass the pricing option selected from `get_signals` to record the buyer's pricing commitment at activation time.

- 2957069: Add promoted-offerings-requirement enum and `requires` property to promoted offerings asset requirements (#1040)
- a7feccb: Add property list check and enhancement to the AAO registry API.

  Registry:

  - New `domain_classifications` table with typed entries (`ad_server`, `intermediary`, `cdn`, `tracker`), seeded with ~60 known ad tech infrastructure domains
  - New `property_check_reports` table stores full check results by UUID for 7 days

  API:

  - `POST /api/properties/check` — accepts up to 10,000 domains, returns remove/modify/assess/ok buckets and a report ID
  - `GET /api/properties/check/:reportId` — retrieve a stored report

  Tools:

  - `check_property_list` MCP tool — runs the check and returns a compact summary + report URL (avoids flooding agent context with thousands of domain entries)
  - `enhance_property` MCP tool — analyzes a single unknown domain: WHOIS age check (< 90 days = high risk), adagents.json validation, AI site structure analysis, submits as pending registry entry for Addie review

- add28ec: Add AI provenance and disclosure schema for creatives and artifacts.

  New schemas:

  - `digital-source-type` enum — IPTC-aligned classification of AI involvement (with `enumDescriptions`)
  - `provenance` core object — declares how content was produced, C2PA references, disclosure requirements, and verification results

  Key design decisions:

  - `verification` is an array (multiple services can independently evaluate content)
  - `declared_by` identifies who attached the provenance claim, enabling trust assessment
  - Provenance is a claim — the enforcing party should verify independently
  - Inheritance uses full-object replacement (no field-level merging)
  - IPTC vocabulary uses current values (`digital_creation`, `human_edits`)

  Optional `provenance` field added to:

  - `creative-manifest` (default for all assets in the manifest)
  - `creative-asset` (default for the creative in the library)
  - `artifact` (top-level and per inline asset type)
  - All 11 typed asset schemas (image, video, audio, text, html, css, javascript, vast, daast, url, webhook)

  Optional `provenance_required` field added to `creative-policy`.

- 73e3639: Add reach as a metric optimization goal and expand frequency cap capabilities.

  **New metric optimization kind:**

  - `reach` added to the `metric` enum on `kind: 'metric'` optimization goals
  - `reach_unit` field — specifies the measurement entity (individuals, households, devices, etc.). Must match a value in `metric_optimization.supported_reach_units`.
  - `target_frequency` field — optional `{ min, max, window }` band that frames frequency as an optimization signal, not a hard cap. `window` is required (e.g., `'7d'`, `'campaign'`) — frequency bands are meaningless without a time dimension. The seller de-prioritizes impressions toward entities already within the band and shifts budget toward unreached entities. Can be combined with `targeting_overlay.frequency_cap` for a hard ceiling.

  **Product capability additions:**

  - `metric_optimization.supported_reach_units` — declares which reach units the product supports for reach optimization goals. Required when `supported_metrics` includes `'reach'`.
  - `reach` added to the `supported_metrics` enum in `metric_optimization`.

  **Frequency cap expansion:**

  - `max_impressions` — maximum impressions per entity per window (integer, minimum 1).
  - `per` — entity to count against, using the same values as `reach-unit` enum (individuals, households, devices, accounts, cookies, custom). Aligns with `reach_unit` on reach optimization goals so hard caps and optimization signals stay in sync.
  - `window` — time window for the cap (e.g., `'1d'`, `'7d'`, `'30d'`, `'campaign'`). Required when `max_impressions` is set.
  - `suppress` (formerly `suppress_minutes`) — cooldown between consecutive exposures, now a duration object (e.g. `{"interval": 60, "unit": "minutes"}`). Optional — the two controls (cooldown vs. impression cap) serve different purposes and can be used independently or together.

- 80afa97: Add sandbox mode as a protocol parameter on all task requests. Sellers declare support via `features.sandbox` in capabilities. Buyers pass `sandbox: true` on any request to run without real platform calls or spend. Replaces the previously documented HTTP header approach (X-Dry-Run, X-Test-Session-ID, X-Mock-Time).
- 2b8d6b6: Schema refinements for frequency caps, signal pricing, audience identifiers, keyword capabilities, and duration representation.

  - **Duration type**: Added reusable `core/duration.json` schema (`{interval, unit}` where unit is `"minutes"`, `"hours"`, `"days"`, or `"campaign"`). Used consistently for all time durations. When unit is `"campaign"`, interval must be 1 — the window spans the full campaign flight. (#1215)
  - **FrequencyCap.window**: Changed from pattern-validated string (`"7d"`) to a duration object (e.g. `{"interval": 7, "unit": "days"}` or `{"interval": 1, "unit": "campaign"}`). Also applied to `optimization_goal.target_frequency.window`. (#1215)
  - **Attribution windows**: Replaced string fields with duration objects throughout. `attribution_window.click_through`/`view_through` (strings) became `post_click`/`post_view` (duration objects) on optimization goals, capability declarations, and delivery response. (#1215)
  - **FlatFeePricing.period**: Added required `period` field (`monthly | quarterly | annual | campaign`) so buyers know the billing cadence for flat-fee signals. (#1216)
  - **FrequencyCap.suppress**: Added `suppress` (duration object, e.g. `{"interval": 60, "unit": "minutes"}`) as the preferred cooldown field. `suppress_minutes` (scalar) is deprecated but still accepted for backwards compatibility. (#1215)
  - **supported_identifier_types**: Removed `platform_customer_id` from the identifier type enum. Added `supports_platform_customer_id` boolean to audience targeting capabilities — a binary capability flag is clearer than an enum value for this closed-ecosystem matching key. (#1217)
  - **Keyword targeting capabilities**: Changed `execution.targeting.keyword_targets` and `execution.targeting.negative_keywords` from boolean to objects with `supported_match_types: ("broad" | "phrase" | "exact")[]`, so buyers know which match types each seller accepts before sending. (#1218)

- 1c5bbb0: Add percent_of_media pricing model and transaction context to signals protocol:

  - **`signal-pricing.json`**: New schema for signal-specific pricing — discriminated union of `cpm` (fixed CPM) and `percent_of_media` (percentage of spend, with optional `max_cpm` cap for TTD-style hybrid pricing)
  - **`signal-pricing-option.json`**: New schema wrapping `pricing_option_id` + `signal-pricing`. The `get_signals` response now uses this instead of the generic media-buy `pricing-option.json`
  - **`signal-filters.json`**: New `max_percent` filter for percent-of-media signals
  - **`get_signals` request**: Optional `account_id` (per-account rate cards) and `buyer_campaign_ref` (correlate discovery with settlement)
  - **`activate_signal` request**: Optional `account_id` and `buyer_campaign_ref` for transaction context

- 8f26baf: Add Swiss (`ch_plz`) and Austrian (`at_plz`) postal code systems to geo targeting.
- b61f271: Add `sync_audiences` task for CRM-based audience management.

  Buyers wrapping closed platforms (LinkedIn, Meta, TikTok, Google Ads) need to upload hashed CRM data before creating campaigns that target or suppress matched audiences. This adds a dedicated task for that workflow, parallel to `sync_event_sources`.

  Schema:

  - New task: `sync_audiences` with request and response schemas
  - New core schema: `audience-member.json` — hashed identifiers for CRM list members (email, phone, MAIDs)
  - `targeting.json`: add `audience_include` and `audience_exclude` arrays for referencing audiences in `create_media_buy` targeting overlays

  Documentation:

  - New task reference: `docs/media-buy/task-reference/sync_audiences.mdx`
  - Updated `docs/media-buy/advanced-topics/targeting.mdx` with `audience_include`/`audience_exclude` overlay documentation

- 142bcd5: Add `rejected` account status for accounts that were never approved. Previously, `closed` covered both "was active, now terminated" and "seller declined the request", which was counterintuitive. Now `pending_approval` → `rejected` (declined) is distinct from `active` → `closed` (terminated).
- f5e6a21: Agent ergonomics improvements from #1240 tracking issue.

  **Media Buy**

  - `get_products`: Add `fields` parameter for response field projection, reducing context window cost for discovery calls
  - `get_media_buy_delivery`: Add `include_package_daily_breakdown` opt-in for per-package daily pacing data
  - `get_media_buy_delivery`: Add `attribution_window` on request for buyer-controlled attribution windows (model optional)
  - `get_media_buys`: Add buy-level `start_time`/`end_time` (min/max of package flight dates)

  **Capabilities**

  - `get_adcp_capabilities`: Add `supported_pricing_models` and `reporting` block (date range, daily breakdown, webhooks, available dimensions) at seller level

  **Audiences**

  - `sync_audiences` request: Add `description`, `audience_type` (crm/suppression/lookalike_seed), and `tags` metadata
  - `sync_audiences` response: Add `total_uploaded_count` for match rate calculation

  **Forecasting**

  - `ForecastPoint.metrics`: Add explicit typed properties for all 13 forecastable-metric enum values

- 0cede41: Add CreativeBrief type to BuildCreativeRequest for structured campaign context

### Patch Changes

- 24782c2: Add dedicated task reference pages for `sync_accounts` and `list_accounts` under Media Buy Protocol Task Reference.
- 719135b: Move accounts management from manage to admin; fix stale prospect links to removed organizations page.
- 5a90c55: Fix Addie billing status conflating active subscriptions with paid invoices.
- cc6da0c: Increase Addie conversation history from 10 to 20 messages for longer debugging sessions.
- 53e1d65: Add property registry context to Addie's tool reference so she understands what the community property registry is, how data is managed across the three source tiers (authoritative/enriched/community), and when to use each property tool.
- d4f7723: Empty changeset — internal Addie improvements (no protocol changes).
- dce0090: Update Addie's test_adcp_agent tool to use @adcp/client 3.20.0 suite API.
- acd9db7: Addie quality improvements from thread review: accurate spec claims, fictional example names, ads.txt knowledge, shorter deflections, agent type awareness, and session-level web feedback prompt.
- 2d072c1: Clarify push notification config flow in docs and schema.

  - Fix `push_notification_config` placement and naming in webhook docs (task body, not protocol metadata)
  - Add `push_notification_config` explicitly to `create_media_buy` request schema
  - Fix `operation_id` description: client-generated, echoed by publisher
  - Fix HMAC signature format to match wire implementation

- 93e19a1: Remove generated_creative_ref from build_creative and preview_creative schemas. Creative refinement uses manifest passback and creative brief updates instead. Document iterative refinement patterns for build_creative and get_signals.
- 2b79286: Clarify that end_date is exclusive in get_media_buy_delivery documentation

  - Add explicit "inclusive" and "exclusive" labels to start_date/end_date parameters
  - Add callout explaining start-inclusive, end-exclusive behavior with examples
  - Add examples table showing common date range patterns
  - Reinforce behavior in Query Behavior section

- 24b972e: Document save endpoints for brands and properties in registry API docs.
- b311f65: Fix Addie brand management: add missing brand tools to tool reference, prevent save_brand from overwriting enrichment data
- 5e5a3b7: Fix Addie streaming errors, MCP token expiry, and SSE error handling.
- d447e71: Fix three brand identity bugs: has_manifest false when brand.json found, uploaded logo not showing on member card, and "Set up brand" link redirecting to dashboard.
- 5b8feea: Fix build_creative doc examples: remove catalog_id from inline catalogs, add missing offering_id to inline offering items.
- 29bfe08: fix: couple brand enrichment to save in public REST endpoint
- 34d2764: Fix incorrect data wrapper in get_products MCP response examples
- 9f70a06: fix: set CORS headers on MCP 401 responses so OAuth flow can start
- 603ed69: Fix duplicate Moltbook Slack notifications from concurrent poster runs
- 894e9e9: Empty changeset — no protocol impact.
- 3378218:
- e84f932: Fix forbidden-field `not: {}` pattern in response schemas and document `deliver_to` breaking change.

  Remove `"not": {}` property-level constraints from 7 response schemas (creative and content-standards). These markers were intended to mark fields as forbidden in discriminated union variants, but caused Python code generators to emit `Any | None` instead of omitting the field. The `oneOf` + `required` constraints provide correct discrimination; the `not: {}` entries were counterproductive — payloads mixing success and error fields are now correctly rejected by `oneOf` instead of being accepted as one variant.

  Add migration guide to release notes for the `get_signals` `deliver_to` restructuring: the nested `deliver_to.deployments` object was replaced by top-level `destinations` and `countries` fields.

- cf3ebb3: Fix schema version alias resolution for prereleases

  - Fix prerelease sorting bug in schema middleware: `/v3/` was resolving to `3.0.0-beta.1` instead of `3.0.0-beta.3` because prereleases were sorted ascending instead of descending
  - Update `sync_event_sources` and `log_event` docs to use `/v3/` schema links (these schemas were added in v3)

- bf19909: Fix API key authentication for WorkOS keys using the new `sk_` prefix. WorkOS changed their key format from `wos_api_key_` to `sk_`, which caused all newer API keys to be rejected by the auth middleware before reaching validation.
- 5418b93: Fix broken schema links in sync_audiences documentation. Changed from `/schemas/v2/` to `/schemas/v1/` since this task was added after the v2.5.x and v3.0.0-beta releases and its schemas only exist in `latest` (which v1 points to).
- 3e7e545: Fix UTF-8 encoding corruption for non-ASCII characters in brand and agent registry files.

  When external servers serve `.well-known/brand.json` or `.well-known/adagents.json` with a non-UTF-8 charset in their `Content-Type` header (e.g. `charset=iso-8859-1`), axios was decoding the UTF-8 response bytes using that charset, corrupting multi-byte characters like Swedish ä/ö/å into mojibake.

  Fix: use `responseType: 'arraybuffer'` on all external fetches so axios delivers raw bytes, then explicitly decode as UTF-8 regardless of what the server declares.

- 751760a:
- 5b7cbb3: Add Lusha-powered company lookup to referral prospect search: domain-first create form auto-imports companies with full enrichment data.
- 5b7cbb3: Add /manage tier for kitchen cabinet governance access
- 5b7cbb3: Add member referral code system: invite prospects with a personalized landing page, lock the discount to their account on acceptance, and show a 30-day countdown in the membership dashboard.
- 333618c: Download brand logos from Brandfetch CDN to our own PostgreSQL-backed store when enriching brands. Logos are served from `/logos/brands/:domain/:idx` so external agents can download them without hitting Brandfetch hotlinking restrictions.
- ae1b769: Release candidate documentation: RC1 release notes covering all changes since beta.3 including keyword targeting, optimization goals redesign, signal pricing, dimension breakdowns, device type targeting, brand identity unification, delivery forecasts, proposal refinement via session continuity, first-class catalogs, new tasks, sandbox mode, and creative briefs. Rewrote intro page and added dedicated architecture page. Updated v3 overview with complete breaking changes and migration checklists.
- 6259155: Restructure registry: unified hub page and dedicated agents page

  - `/registry` is now a hub page showing all four entity types (Members, Agents, Brands, Properties)
  - `/agents` is now the dedicated agent registry page (formerly at `/registry`)
  - The duplicate "quick links" section that mirrored the tabs on the agent page has been removed
  - `agents`, `brands`, and `publishers` added to reserved member profile slugs

- e6a62ad:
- 34ac3ba: Clarify schema descriptions (ai_tool.version, buyer_ref deduplication) and add attribution migration guide and creative agent disclosure guidance from downstream feedback.
- 155bb4d: Add schema link checker workflow for docs PRs. The checker validates that schema URLs in documentation point to schemas that exist, and warns when schemas exist in source but haven't been released yet.

  Update schema URLs from v1/v2 to v3 across documentation for schemas that are only available in v3:

  - Content standards tasks (calibrate_content, create/get/list/update_content_standards, get_media_buy_artifacts, validate_content_delivery)
  - Creative delivery (get_creative_delivery)
  - Conversion tracking (log_event, sync_event_sources, event-custom-data, user-match)
  - Pricing options (cpa-option, cpm-option, time-option, vcpm-option)
  - Property governance (base-property-source)
  - Protocol capabilities (get-adcp-capabilities-response)
  - Media buy operations (get_media_buys, sync_audiences)
  - Migration guides and reference docs

  Some of these schemas are already released in 3.0.0-beta.3, others will be available in the next beta release (3.0.0-beta.4).

- b61fcd7: Register all tool sets for web chat, matching Slack channel parity. Previously web chat only had knowledge, billing, and schema tools — brand, directory, property, admin, events, meetings, collaboration, and other tools were missing, causing "Unknown tool" errors. Extracts shared baseline tool registration into a single module both channels import.
- 565fb86: Made font and tagline fields editable in brand registry on the UI

## 3.0.0-beta.3

### Major Changes

- e81235c: Add structured tone guidelines and structured logo fields to Brand Manifest schema.

  **BREAKING: Tone field changes:**

  - Tone is now an object type only (string format removed)
  - Structured tone includes `voice`, `attributes`, `dos`, and `donts` fields
  - Existing string values should migrate to `{ "voice": "<previous-string>" }`
  - Enables creative agents to generate brand-compliant copy programmatically

  **Logo object changes:**

  - Added `orientation` enum field: `square`, `horizontal`, `vertical`, `stacked`
  - Added `background` enum field: `dark-bg`, `light-bg`, `transparent-bg`
  - Added `variant` enum field: `primary`, `secondary`, `icon`, `wordmark`, `full-lockup`
  - Added `usage` field for human-readable descriptions
  - Kept `tags` array for additional custom categorization

  These structured fields enable creative agents to reliably filter and select appropriate logo variants.

  Closes #945

- 96a90ec: Standardize cursor-based pagination across all list operations.

  ### Breaking Changes

  - **`list_creatives`**: Replace offset-based `limit`/`offset` with cursor-based `pagination` object
  - **`tasks_list`**: Replace offset-based `limit`/`offset` with cursor-based `pagination` object
  - **`list_property_lists`**: Move top-level `max_results`/`cursor` into nested `pagination` object
  - **`get_property_list`**: Move top-level `max_results`/`cursor` into nested `pagination` object
  - **`get_media_buy_artifacts`**: Move top-level `limit`/`cursor` into nested `pagination` object

  ### Non-Breaking Changes

  - Add shared `pagination-request.json` and `pagination-response.json` schemas to `core/`
  - Add optional `pagination` support to `list_accounts`, `get_products`, `list_creative_formats`, `list_content_standards`, and `get_signals`
  - Update documentation for all affected operations

  All list operations now use a consistent pattern: `pagination.max_results` + `pagination.cursor` in requests, `pagination.has_more` + `pagination.cursor` + optional `pagination.total_count` in responses.

### Minor Changes

- d7e7550: Add optional account_id parameter to get_media_buy_delivery and get_media_buy_artifacts requests, allowing buyers to scope queries to a specific account.
- b708168: Add sync_accounts task, authorized_operators, and account capabilities to AdCP.

  `account_id` is optional on `create_media_buy`. Single-account agents can omit it; multi-account agents must provide it.

  - `sync_accounts` task: Agent declares brand portfolio to seller with upsert semantics
  - `authorized_operators` in brand.json: Brand declares which operators can represent them
  - Account capabilities in `get_adcp_capabilities`: require_operator_auth, supported_billing, required_for_products
  - Three-party billing model: brand, operator, agent
  - Account status lifecycle: active, pending_approval, payment_required, suspended, closed

- 0da0b36: Add channel fields to property and product schemas. Properties can now declare `supported_channels` and products can declare `channels` to indicate which advertising channels they align with. Both fields reference the Media Channel Taxonomy enum and are optional.
- ac4a81f: Add CPA (Cost Per Acquisition) pricing model for outcome-based campaigns.

  CPA enables advertisers to pay per conversion event (purchase, lead, signup, etc.) rather than per impression or click. The pricing option declares which `event_type` triggers billing, independent of any optimization goal.

  This single model covers use cases previously described as CPO (Cost Per Order), CPL (Cost Per Lead), and CPI (Cost Per Install) — differentiated by event type rather than separate pricing models.

  New schema:

  - `cpa-option.json`: CPA pricing option (fixed price per conversion event)

  Updated schemas:

  - `pricing-model.json`: Added `cpa` enum value
  - `pricing-option.json`: Added cpa-option to discriminated union
  - `index.json`: Added cpa-option to registry

- 34ece9f: Add conversion tracking with log_event and sync_event_sources tasks
- 098fce2: Add TIME pricing model for sponsorship-based advertising where price scales with campaign duration. Supports hour, day, week, and month time units with optional min/max duration constraints.
- a854090: Add attribution window metadata to delivery response. The response root now includes an optional `attribution_window` object describing `click_window_days`, `view_window_days`, and attribution `model` (last_touch, first_touch, linear, time_decay, data_driven). Placed at response level since all media buys from a single seller share the same attribution methodology. Enables cross-platform comparison of conversion metrics.
- 8a8e4e7: Add Brand Protocol for brand discovery and identity resolution

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

- 8079271: Add commerce attribution metrics to delivery response schema. Adds `new_to_brand_rate` as a first-class field in DeliveryMetrics. Adds `roas` and `new_to_brand_rate` to `aggregated_totals` and `daily_breakdown` in the delivery response. Updates documentation to reflect commerce metric availability.
- 37dbd0d: Add creative delivery reporting to the AdCP specification.

  - Add optional `by_creative` metrics breakdown within `by_package` in delivery responses
  - Add `get_creative_delivery` task on creative agents for variant-level delivery data with manifests
  - Add `creative-variant` core object supporting three tiers: standard (1:1), asset group optimization, and generative creative. Variants include full creative manifests showing what was rendered.
  - Extend `preview_creative` with `request_type: "variant"` for post-flight variant previews
  - Add `selection_mode` to repeatable asset groups to distinguish sequential (carousel) from optimize (asset pool) behavior
  - Add `supports_creative_breakdown` to reporting capabilities
  - Add `delivery` creative agent capability

- 37f46ec: Add delivery forecasting to the Media Buy protocol

  - Add `DeliveryForecast` core type with budget curve, forecast method, currency, and measurement context
  - Add `ForecastRange` core type (low/mid/high) for metric forecasts
  - Add `ForecastPoint` core type — pairs a budget level with metric ranges; single point is a standard forecast, multiple points form a budget curve
  - Add `forecast-method` enum (estimate, modeled, guaranteed)
  - Add `forecastable-metric` enum defining standard metric vocabulary (audience_size, reach, impressions, clicks, spend, etc.)
  - Add `demographic-system` enum (nielsen, barb, agf, oztam, mediametrie, custom) for GRP demographic notation
  - Add `reach-unit` enum (individuals, households, devices, accounts, cookies, custom) for cross-channel reach comparison
  - Add `demographic_system` to CPP pricing option parameters
  - Add optional `forecast` field to `ProductAllocation`
  - Add optional `forecast` field to `Proposal`
  - Add `daypart-target` core type for explicit day+hour targeting windows (follows Google Ads / DV360 pattern)
  - Add `day-of-week` enum (monday through sunday)
  - Add `forecast-range-unit` enum (spend, reach_freq, weekly, daily, clicks, conversions) for interpreting forecast curves
  - Add `daypart_targets` to `Targeting` for hard daypart constraints
  - Add `daypart_targets` to `ProductAllocation` for publisher-recommended time windows in spot plans
  - Add `forecast_range_unit` to `DeliveryForecast` for curve type identification
  - Document forecast scenarios: budget curves, CTV with GRP demographics, retail media with outcomes, allocation-level forecasts

- f37a00c: Deprecate FormatCategory enum and make `type` field optional in Format objects

  The `type` field (FormatCategory) is now optional on Format objects. The `assets` array is the authoritative source for understanding creative requirements.

  **Rationale:**

  - Categories like "video", "display", "native" are lossy abstractions that don't scale to emerging formats
  - Performance Max spans video, display, search, and native simultaneously
  - Search ads (RSA) are text-only with high intent context - neither "display" nor "native" fits
  - The `assets` array already provides precise information about what asset types are needed

  **Migration:**

  - Existing formats with `type` field continue to work
  - New formats may omit `type` entirely
  - Buyers should inspect the `assets` array to understand creative requirements

- 37dbd0d: Add reported_metrics to creative formats and expand available-metric enum
- a859fd1: Add geographic exclusion targeting fields to targeting overlay schema.

  New fields: `geo_countries_exclude`, `geo_regions_exclude`, `geo_metros_exclude`, `geo_postal_areas_exclude`. These enable RCT holdout groups and regulatory compliance exclusions without requiring exhaustive inclusion lists.

- 8836151: Make top-level format_id optional in preview_creative request. The field was redundant with creative_manifest.format_id (which is always required). Callers who omit it fall back to creative_manifest.format_id. Existing callers who send both still work.
- 96d6fa0: Add product_selectors to get_products for commerce product discovery. Add manifest_gtins to promoted-products schema for cross-retailer GTIN matching.
- c8cdbca: Add Signal Catalog feature for data providers

  Data providers (Polk, Experian, Acxiom, etc.) can now publish signal catalogs via `adagents.json`, enabling AI agents to discover, verify authorization, and activate their signals—without custom integrations.

  **Why this matters:**

  - **Discovery**: AI agents can find signals via natural language or structured lookup
  - **Authorization verification**: Buyers can verify a signals agent is authorized by checking the data provider's domain directly
  - **Typed targeting**: Signal definitions include value types (binary, categorical, numeric) so agents construct correct targeting expressions
  - **Scalable partnerships**: Authorize agents once; as you add signals, authorized agents automatically have access

  **New schemas:**

  - `signal-id.json` - Universal signal identifier with `source` discriminator: `catalog` (data_provider_domain + id, verifiable) or `agent` (agent_url + id, trust-based)
  - `signal-definition.json` - Signal spec in data provider's catalog
  - `signal-targeting.json` - Discriminated union for targeting by value_type
  - `signal-category.json` / `signal-value-type.json` / `signal-source.json` - Enums

  **Modified schemas:**

  - `adagents.json` - Added `signals` array, `signal_tags`, and signal authorization types
  - `get-signals-request.json` / `get-signals-response.json` - Added `signal_ids` lookup and structured responses
  - `product.json` - Added `signal_targeting_allowed` flag

  **Server updates:**

  - `AdAgentsManager` - Full signals validation, creation, and authorization verification
  - AAO Registry - Data providers as first-class member type with federated discovery

  See [Data Provider Guide](/docs/signals/data-providers) for implementation details.

- e84aafd: Add functional restriction overlays: age_restriction (with verification methods for compliance), device_platform (technical compatibility using Sec-CH-UA-Platform values), and language (localization). These are compliance/technical restrictions, not audience targeting - demographic preferences should be expressed in briefs.
- f543f44: Add typed asset requirements schemas for creative formats

  Introduces explicit requirement schemas for every asset type with proper discriminated unions. In `format.json`, assets use `oneOf` with `asset_type` as the discriminator - each variant pairs a specific `asset_type` const with its typed requirements schema. This produces clean discriminated union types for code generation.

  - **image-asset-requirements**: `min_width`, `max_width`, `min_height`, `max_height`, `formats`, `max_file_size_kb`, `animation_allowed`, etc.
  - **video-asset-requirements**: dimensions, duration, `containers`, `codecs`, `max_bitrate_kbps`, etc.
  - **audio-asset-requirements**: `min_duration_ms`, `max_duration_ms`, `formats`, `sample_rates`, `channels`, bitrate constraints
  - **text-asset-requirements**: `min_length`, `max_length`, `min_lines`, `max_lines`, `character_pattern`, `prohibited_terms`
  - **markdown-asset-requirements**: `max_length`
  - **html-asset-requirements**: `sandbox` (none/iframe/safeframe/fencedframe), `external_resources_allowed`, `allowed_external_domains`, `max_file_size_kb`
  - **css-asset-requirements**: `max_file_size_kb`
  - **javascript-asset-requirements**: `module_type`, `external_resources_allowed`, `max_file_size_kb`
  - **vast-asset-requirements**: `vast_version`
  - **daast-asset-requirements**: `daast_version`
  - **promoted-offerings-asset-requirements**: (extensible)
  - **url-asset-requirements**: `protocols`, `allowed_domains`, `macro_support`, `role`
  - **webhook-asset-requirements**: `methods`

  This allows sales agents to declare execution environment constraints for HTML creatives (e.g., "must work in SafeFrame with no external JS") as part of the format definition.

- efa8e6a: Add universal macro enum schema and improve macro documentation

  Schema:

  - Add universal-macro.json enum defining all 54 standard macros with descriptions
  - Update format.json supported_macros to reference enum (backward compatible via oneOf)
  - Update webhook-asset.json supported_macros and required_macros to reference enum
  - Register universal-macro enum in schema index

  New Macros:

  - GPP_SID: Global Privacy Platform Section ID(s) for privacy framework identification
  - IP_ADDRESS: User IP address with privacy warnings (often masked/restricted)
  - STATION_ID: Radio station or podcast identifier
  - SHOW_NAME: Program or show name
  - EPISODE_ID: Podcast episode identifier
  - AUDIO_DURATION: Audio content duration in seconds

  Documentation:

  - Add GPP_SID to Privacy & Compliance Macros section
  - Add IP_ADDRESS with privacy warning callout
  - Add Audio Content Macros section for audio-specific macros
  - Add TIMESTAMP to availability table
  - Add GPP_STRING and GPP_SID to availability table
  - Add IP_ADDRESS to availability table with privacy restriction notation (✅‡)
  - Add Audio Content macros to availability table
  - Update legend with ✅‡ notation for privacy-restricted macros

### Patch Changes

- 330676f: Replace Coke/Publicis examples with fictional brands (Acme Corp, Pinnacle Media, Nova Brands) and add CLAUDE.md rule against using real brand names in examples.

## 3.0.0-beta.2

### Minor Changes

- 8b8b63c: Add A2UI and MCP Apps support to Sponsored Intelligence for agent-driven UI rendering.
- 8e37138: Add accounts and agents specification to AdCP protocol.

  AdCP now distinguishes three entities in billable operations:

  - **Brand**: Whose products are advertised (identified by brand manifest)
  - **Account**: Who gets billed, what rates apply (identified by `account_id`)
  - **Agent**: Who is placing the buy (identified by authentication token)

  New schemas:

  - `account.json`: Billing relationship with rate cards, payment terms, credit limits
  - `list-accounts-request.json` / `list-accounts-response.json`: Discover accessible accounts

  Updated schemas:

  - `media-buy.json`: Added account attribution
  - `create-media-buy-request.json`: Added optional `account_id` field
  - `create-media-buy-response.json`: Added account in response
  - `get-products-request.json`: Added optional `account_id` for rate card context
  - `sync-creatives-request.json`: Added optional `account_id` field for creative ownership
  - `sync-creatives-response.json`: Added account attribution in response
  - `list-creatives-response.json`: Added account attribution per creative
  - `creative-filters.json`: Added `account_ids` filter for querying by account

  Deprecates the "Principal" terminology in favor of the more precise Account/Agent distinction.

- cd0274e: Add "creative" to supported_protocols enum in get_adcp_capabilities. Creative agents indicate protocol support via presence in supported_protocols array.
- 1d7c687: Add governance and SI agent types to Addie with complete AdCP protocol tool coverage. Adds 21 new tools for update_media_buy, list_creatives, provide_performance_feedback, property lists, content standards, sponsored intelligence, and get_adcp_capabilities.
- 895bd23: Add property targeting for products and packages

  **Product schema**: Add `property_targeting_allowed` flag to declare whether buyers can filter a product to a subset of its `publisher_properties`:

  - `property_targeting_allowed: false` (default): Product is "all or nothing" - excluded from `get_products` results unless buyer's list contains all properties
  - `property_targeting_allowed: true`: Product included if any properties intersect with buyer's list

  **Targeting overlay schema**: Add `property_list` field to specify which properties to target when purchasing products with `property_targeting_allowed: true`. The package runs on the intersection of the product's properties and the buyer's list.

  This enables publishers to offer run-of-network products that can't be cherry-picked alongside flexible inventory where buyers can target specific properties.

- 2a82501: Add video and audio technical constraint fields for CTV and streaming platforms

  - Add frame rate constraints: acceptable_frame_rates, frame_rate_type, scan_type
  - Add color/HDR fields: color_space, hdr_format, chroma_subsampling, video_bit_depth
  - Add GOP/streaming fields: gop_interval_seconds_min/max, gop_type, moov_atom_position
  - Add audio constraints: audio_required, audio_codec, audio_sampling_rate_hz, audio_channels, audio_bit_depth, audio_bitrate_kbps_min/max
  - Add audio loudness fields: audio_loudness_lufs, audio_loudness_tolerance_db, audio_true_peak_dbfs
  - Extend video-asset.json and audio-asset.json with matching properties
  - Add CTV format examples to video documentation

### Patch Changes

- cef3dfc: Add committee leadership tools for Addie - allows committee leaders to add/remove co-leaders for their own committees (working groups, councils, chapters, industry gatherings) without requiring admin access
- b2189d5: Register account domain with list_accounts task in schema index
- 34c7f8a: Refactor members page to remove pricing table and add URL filter support

  - Replace full pricing grid with compact "Become a Member" banner linking to /membership
  - Add URL query parameter support for filtering (e.g., /members?type=sales_agent)
  - URL updates as users interact with filters for shareable/bookmarkable views

- 00cd9b8: Extract shared PriceGuidance schema to fix duplicate type generation

  **Schema Changes:**

  - Create new `/schemas/pricing-options/price-guidance.json` shared schema
  - Update all 7 pricing option schemas to use `$ref` instead of inline definitions

  **Issue Fixed:**

  - Fixes #884 (Issue 1): Duplicate `PriceGuidance` classes causing mypy arg-type errors
  - When Python types are generated, there will now be a single `PriceGuidance` class instead of 7 identical copies

  **Note:** Issue 2 (RootModel wrappers) requires Python library changes to export type aliases for union types.

- d66bf3d: Remove deprecated v3 features: list_property_features task, list_authorized_properties task, adcp-extension.json schema, assets_required format field, and preview_image format field. All removed items have replacements via get_adcp_capabilities and the new assets discovery model.
- 69435f3: Fix onboarding redirect and add org admin audit tool

  - Remove ?signup parameter check in onboarding - users with existing org memberships now always redirect to dashboard
  - Add admin tool to audit organizations without admins
  - Auto-fix single-member orgs; flag multi-member orgs for manual review

## 3.0.0-beta.1

### Major Changes

- f4ef555: Add Media Channel Taxonomy specification with standardized channel definitions.

  **BREAKING**: Replaces channel enum values (display, video, audio, native, retail → display, olv, social, search, ctv, etc.)

  - Introduces 19 planning-oriented media channels representing how buyers allocate budget
  - Channels: display, olv, social, search, ctv, linear_tv, radio, streaming_audio, podcast, dooh, ooh, print, cinema, email, gaming, retail_media, influencer, affiliate, product_placement
  - Adds desktop_app property type for Electron/Chromium wrapper applications
  - Clear distinction between channels (planning abstractions), property types (addressable surfaces), and formats (how ads render)
  - Includes migration guide and edge cases documentation

- a0039cc: Clarify pricing option field semantics with better separation of hard constraints vs soft hints

  **Breaking Changes:**

  - Rename `fixed_rate` → `fixed_price` in all pricing option schemas
  - Move `price_guidance.floor` → top-level `floor_price` field
  - Remove `is_fixed` discriminator (presence of `fixed_price` indicates fixed pricing)

  **Schema Consolidation:**

  - Consolidate 9 pricing schemas into 7 (one per pricing model)
  - All models now support both fixed and auction pricing modes

  **Semantic Distinction:**

  - Hard constraints (`fixed_price`, `floor_price`) - Publisher-enforced prices that cause bid rejection
  - Soft hints (`price_guidance.p25`, `.p50`, `.p75`, `.p90`) - Historical percentiles for bid calibration

### Minor Changes

- f4ef555: Add unified `assets` field to format schema for better asset discovery

  - Add new `assets` array to format schema with `required` boolean per asset
  - Deprecate `assets_required` (still supported for backward compatibility)
  - Enables full asset discovery for buyers and AI agents to see all supported assets
  - Optional assets like impression trackers can now be discovered and used

- f4ef555: Add Content Standards Protocol for content safety and suitability evaluation.

  Discovery tasks:

  - `list_content_features`: Discover available content safety features
  - `list_content_standards`: List available standards configurations
  - `get_content_standards`: Retrieve content safety policies

  Management tasks:

  - `create_content_standards`: Create a new standards configuration
  - `update_content_standards`: Update an existing configuration
  - `delete_content_standards`: Delete a configuration

  Calibration & Validation tasks:

  - `calibrate_content`: Collaborative dialogue to align on policy interpretation
  - `validate_content_delivery`: Batch validate delivery records

- f4ef555: Add protocol-level get_adcp_capabilities task for cross-protocol capability discovery

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

  _Coverage filters (for locally-bound inventory like radio, OOH, local TV):_

  - `countries` - country coverage (ISO 3166-1 alpha-2)
  - `regions` - region coverage (ISO 3166-2) for regional OOH, local TV
  - `metros` - metro coverage ({ system, code }) for radio, DOOH, DMA-based inventory

  _Capability filters (for digital inventory with broad coverage):_

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

- f4ef555: Add privacy_policy_url field to brand manifest and adagents.json schemas

  Enables consumer consent flows by providing a link to advertiser/publisher privacy policies. AI platforms can use this to present explicit privacy choices to users before data handoff. Works alongside MyTerms/IEEE P7012 discovery for machine-readable privacy terms.

- f4ef555: Clarify creative handling in media buy operations:

  **Breaking:** Replace `creative_ids` with `creative_assignments` in `create_media_buy` and `update_media_buy`

  - `creative_assignments` supports optional `weight` and `placement_ids` for granular control
  - Simple assignment: `{ "creative_id": "my_creative" }` (weight/placement optional)
  - Advanced assignment: `{ "creative_id": "my_creative", "weight": 60, "placement_ids": ["p1"] }`

  **Clarifications:**

  - `creatives` array creates NEW creatives only (add `CREATIVE_ID_EXISTS` error)
  - `delete_missing` in sync_creatives cannot delete creatives in active delivery (`CREATIVE_IN_ACTIVE_DELIVERY` error)
  - Document that existing library creatives should be managed via `sync_creatives`

- f4ef555: Add OpenAI Commerce integration to brand manifest

  - Add `openai_product_feed` as a supported feed format for product catalogs
  - Add `agentic_checkout` object to enable AI agents to complete purchases via structured checkout APIs
  - Document field mapping from Google Merchant Center to OpenAI Product Feed spec

- f4ef555: Add Property Governance Protocol support to get_products

  - Add optional `property_list` parameter to get_products request for filtering products by property list
  - Add `property_list_applied` response field to indicate whether filtering was applied
  - Enables buyers to pass property lists from governance agents to sales agents for compliant inventory discovery

- 5b45d83: Refactor schemas to use $ref for shared type definitions

  **New shared type:**

  - `core/media-buy-features.json` - Shared definition for media-buy protocol features (inline_creative_management, property_list_filtering, content_standards)

  **Breaking change:**

  - `required_features` in product-filters.json changed from string array to object with boolean properties
    - Before: `["content_standards", "inline_creative_management"]`
    - After: `{ "content_standards": true, "inline_creative_management": true }`
  - This aligns the filter format with the capabilities declaration format in `get_adcp_capabilities`

  **Schema deduplication:**

  - `get-adcp-capabilities-response.json`: `media_buy.features` now uses $ref to `core/media-buy-features.json`
  - `product-filters.json`: `required_features` now uses $ref to `core/media-buy-features.json`
  - `artifact.json`: `property_id` now uses $ref to `core/identifier.json`
  - `artifact.json`: `format_id` now uses $ref to `core/format-id.json`

  **Benefits:**

  - Single source of truth for shared types
  - Consistent validation across all usages
  - Reduced schema maintenance burden

### Patch Changes

- 240b50c: Add Addie code version tracking and shorter performance timeframes
- ccdbe18: Fix Addie alert spam and improve content relevance

  **Alert deduplication fix:**
  The alert query now checks if ANY perspective with the same external_url
  has been alerted to a channel, preventing spam from cross-feed duplicates.

  **Content relevance improvement:**
  Tightened `mentions_agentic` detection to require BOTH agentic AI terms
  AND advertising context. This prevents general AI news (e.g., ChatGPT updates)
  from being flagged as relevant to our agentic advertising community.

- f4ef555: Fix Mintlify callout syntax and add case-insensitivity notes for country/language codes

  - Convert `:::note` Docusaurus syntax to Mintlify `<Note>` components
  - Add case-insensitivity documentation for country codes (ISO 3166-1 alpha-2) and language codes (ISO 639-1/BCP 47)
  - Remove orphaned webhook-config.json and webhook-authentication.json schemas

- ec0e4fe: Fix API response parsing in Addie member tools

  Multiple MCP tool handlers were incorrectly parsing API responses, expecting flat arrays/objects when APIs return wrapped responses. Fixed:

  - `list_working_groups`: Extract `working_groups` from `{ working_groups: [...] }`
  - `get_working_group`: Extract `working_group` from `{ working_group: {...}, is_member }`
  - `get_my_working_groups`: Extract `working_groups` from wrapped response
  - `get_my_profile`: Extract `profile` from `{ profile, organization_id, organization_name }`

- 99f7f60: Fix pagination in auto-add domain users feature to fetch all organization members
- a7f0d87: Remove deprecated schema files no longer part of v3 schema design:
  - `creative-formats-v1.json` - replaced by modular format schemas in `source/core/`
  - `standard-format-ids.json` - enum no longer used in current schema structure
  - Cleaned up `index.json` registry (removed stale changelog and version fields)
- 6708ad4: Add debug logging support to Addie's AdCP tools and clarify probe vs test behavior.

  - Add `debug` parameter to all 10 AdCP tool schemas (get_products, create_media_buy, etc.)
  - Include debug_logs in tool output when debug mode is enabled
  - Remove redundant `call_adcp_agent` tool (individual tools provide better schema validation)
  - Fix `probe_adcp_agent` messaging to clarify it only checks connectivity, not protocol compliance

- 65358cb: Fix profile visibility check for invoice-based memberships (Founding Members)
- 91f7bb3: docs: Consolidate data models and schema versioning into schemas-and-sdks page

## 2.6.0

### Major Changes

- Add Content Standards Protocol for brand safety and suitability evaluation (#621)

  **New Protocol:**

  Introduces a comprehensive content standards framework enabling buyers to define, calibrate, and enforce brand safety policies across advertising placements.

  **New Tasks:**

  - `list_content_standards` - List available content standards configurations
  - `get_content_standards` - Retrieve full standards configuration with policy details
  - `create_content_standards` - Create new content standards configuration
  - `update_content_standards` - Update existing content standards configuration
  - `calibrate_content` - Collaborative calibration dialogue for policy alignment
  - `validate_content_delivery` - Batch validate delivery records against standards
  - `get_media_buy_artifacts` - Retrieve content artifacts from media buys for validation

  **New Schemas:**

  - `content-standards.json` - Reusable content standards configuration
  - `content-standards-artifact.json` - Content artifact for evaluation
  - `artifact-webhook-payload.json` - Webhook payload for artifact delivery

- Add Property Governance Protocol for AdCP 3.0 (#588)

  **New Protocol:**

  Enables governance agents to evaluate properties against feature-based requirements for brand safety, content quality, and compliance.

  **New Tasks:**

  - `list_property_features` - Discover governance agent capabilities
  - `create_property_list` - Create managed property lists with filters
  - `update_property_list` - Update existing property lists
  - `get_property_list` - Retrieve property list with resolved properties
  - `list_property_lists` - List all property lists
  - `delete_property_list` - Delete a property list

  **New Schemas:**

  - `property-feature-definition.json` - Feature definition schema
  - `property-feature.json` - Feature assessment schema
  - `feature-requirement.json` - Feature-based requirement schema
  - `property-list.json` - Managed property list schema
  - `property-list-filters.json` - Dynamic filter schema
  - `property-list-changed-webhook.json` - Webhook payload for list changes

### Minor Changes

- Add unified `assets` field to format schema for better asset discovery

  **Schema Changes:**

  - **format.json**: Add new `assets` array field that includes both required and optional assets
  - **format.json**: Deprecate `assets_required` (still supported for backward compatibility)

  **Rationale:**

  Previously, buyers and AI agents could only see required assets via `assets_required`. There was no way to discover optional assets that enhance creatives (companion banners, third-party tracking pixels, etc.).

  Since each asset already has a `required` boolean field, we introduced a unified `assets` array where:

  - `required: true` - Asset MUST be provided for a valid creative
  - `required: false` - Asset is optional, enhances the creative when provided

  This enables:

  - **Full asset discovery**: Buyers and AI agents can see ALL assets a format supports
  - **Richer creatives**: Optional assets like impression trackers can now be discovered and used
  - **Cleaner schema**: Single array instead of two separate arrays

  **Example:**

  ```json
  {
    "format_id": {
      "agent_url": "https://creative.adcontextprotocol.org",
      "id": "video_30s"
    },
    "assets": [
      {
        "item_type": "individual",
        "asset_id": "video_file",
        "asset_type": "video",
        "required": true
      },
      {
        "item_type": "individual",
        "asset_id": "end_card",
        "asset_type": "image",
        "required": false
      },
      {
        "item_type": "individual",
        "asset_id": "impression_tracker",
        "asset_type": "url",
        "required": false
      }
    ]
  }
  ```

  **Migration:** Non-breaking change. `assets_required` is deprecated but still supported. New implementations should use `assets`.

- Add typed extensions infrastructure with auto-discovery (#648)

  **New Feature:**

  Introduces a typed extension system allowing vendors and domains to add custom data to AdCP schemas in a discoverable, validated way.

  **New Schemas:**

  - `extensions/extension-meta.json` - Meta schema for extension definitions
  - `extensions/index.json` - Auto-generated registry of all extensions
  - `protocols/adcp-extension.json` - AdCP extension for agent cards

  **Benefits:**

  - Vendor-specific data without polluting core schemas
  - Auto-discovery of available extensions
  - Validation support for extension data

- Add OpenAI Commerce integration to brand manifest (#802)

  **Schema Changes:**

  - **brand-manifest.json**: Add `openai_commerce` field for OpenAI shopping integration

  Enables brands to include their OpenAI Commerce merchant ID for AI-powered shopping experiences.

- Add privacy_policy_url to brand manifest and adagents.json (#801)

  **Schema Changes:**

  - **brand-manifest.json**: Add optional `privacy_policy_url` field
  - **adagents.json**: Add optional `privacy_policy_url` field

  Enables publishers and brands to declare their privacy policy URLs for compliance and transparency.

- Refactor: replace creative_ids with creative_assignments (#794)

  **Breaking Change:**

  Package schema now uses `creative_assignments` array instead of `creative_ids` for more flexible creative-to-package mapping with placement support.

  **Migration:**

  ```json
  // Before
  { "creative_ids": ["creative_1", "creative_2"] }

  // After
  { "creative_assignments": [
    { "creative_id": "creative_1" },
    { "creative_id": "creative_2", "placement_ids": ["homepage_banner"] }
  ]}
  ```

### Patch Changes

- fix: Mintlify callout syntax and case-insensitivity docs (#834)
- fix: Convert governance docs to relative links (#820)
- build: rebuild dist/schemas/2.6.0 with impressions and paused fields
- chore: regenerate dist/schemas/2.6.0 with additionalProperties: true
- ci: add 2.6.x branch to all workflows
- docs: add deprecated assets_required examples with deprecation comments
- schema: make 'required' field mandatory in assets array and nested repeatable_group assets
- schema: add formal deprecated: true to assets_required field

## 2.5.3

### Patch Changes

- 309a880: Allow additional properties in all JSON schemas for forward compatibility

  Changes all schemas from `"additionalProperties": false` to `"additionalProperties": true`. This enables clients running older schema versions to accept responses from servers with newer schemas without breaking validation - a standard practice for protocol evolution in distributed systems.

- 5d0ce75: Add explicit type definition to error.json details property

  The `details` property in core/error.json now explicitly declares `"type": "object"` and `"additionalProperties": true`, consistent with other error details definitions in the codebase. This addresses issue #343 where the data type was unspecified.

- cdcd70f: Fix migration 151 to delete duplicates before updating Slack IDs to WorkOS IDs
- 39abf79: Add missing fields to package request schemas for consistency with core/package.json.

  **Schema Changes:**

  - `media-buy/package-request.json`: Added `impressions` and `paused` fields
  - `media-buy/update-media-buy-request.json`: Added `impressions` field to package updates

  **Details:**

  - `impressions`: Impression goal for the package (optional, minimum: 0)
  - `paused`: Create package in paused state (optional, default: false)

  These fields were defined in `core/package.json` but missing from the request schemas, making it impossible to set impression goals or initial paused state when creating/updating media buys.

  **Documentation:**

  - Updated `create_media_buy` task reference with new package parameters
  - Updated `update_media_buy` task reference with impressions parameter

- fa68588: fix: display Slack profile name for chapter leaders without WorkOS accounts

  Leaders added via Slack ID that haven't linked their WorkOS account now display
  their Slack profile name (real_name or display_name) instead of the raw Slack
  user ID (e.g., U09BEKNJ3GB).

  The getLeaders and getLeadersBatch queries now include slack_user_mappings as an
  additional name source in the COALESCE chain.

- 9315247: Release schemas with `additionalProperties: true` for forward compatibility

  This releases `dist/schemas/2.5.2/` containing the relaxed schema validation
  introduced in #646. Clients can now safely ignore unknown fields when parsing
  API responses, allowing the API to evolve without breaking existing integrations.

## 2.5.2

### Patch Changes

- Add documentation versioning support with Mintlify
  - Version switcher dropdown with 2.5 (default) and 2.6-rc (preview)
  - GitHub Actions workflow to sync 2.6.x branch docs to v2.6-rc
  - Local sync script for testing (`npm run sync:docs`)

## 2.5.1

### Patch Changes

- 72a5802: Fix semantic version sorting for agreements. When multiple agreement versions share the same effective date, the system now correctly selects the highest version (e.g., 1.1.1 before 1.1).
- 935eb43: Fix JSON Schema validation failures when using allOf composition with additionalProperties: false.

  Schemas using `allOf` to compose with base schemas (dimensions.json, push-notification-config.json) were failing AJV validation because each sub-schema independently rejected the other's properties.

  **Fixed schemas:**

  - `dimensions.json` - removed `additionalProperties: false` (composition-only schema)
  - `push-notification-config.json` - removed `additionalProperties: false` (used via allOf in reporting_webhook)
  - `video-asset.json` - inlined width/height properties, removed allOf
  - `image-asset.json` - inlined width/height properties, removed allOf

  **Added:**

  - New `test:composed` script to validate data against schemas using allOf composition
  - Added to CI pipeline to prevent regression
  - Bundled (dereferenced) schemas at `/schemas/{version}/bundled/` for tools that don't support $ref resolution

  Fixes #275.

- 10d5b6a: Fix analytics dashboard revenue tracking with Stripe webhook customer linkage
- b3b4eed: Fix reporting_webhook schema to enable additionalProperties validation.

  Inlined push-notification-config fields because allOf + additionalProperties:false breaks PHP schema generation (reported by Lukas Meier). Documented this pattern in CLAUDE.md.

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
    "buyer_ref": "media_buy_ref",
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
