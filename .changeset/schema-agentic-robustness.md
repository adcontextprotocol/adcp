---
"adcontextprotocol": major
---

Address schema gaps that block autonomous agent operation, plus consistency fixes.

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
