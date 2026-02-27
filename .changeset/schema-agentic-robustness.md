---
"adcontextprotocol": major
---

Address 17 schema gaps that block autonomous agent operation.

**Error handling (#1223)**
- `Error`: add `recovery` field (`transient | correctable | terminal`) so agents can classify failures without escalating every error to humans
- New `enums/error-code.json`: standard vocabulary (`RATE_LIMITED`, `SERVICE_UNAVAILABLE`, `PRODUCT_UNAVAILABLE`, `PROPOSAL_EXPIRED`, `BUDGET_TOO_LOW`, `CREATIVE_REJECTED`, `UNSUPPORTED_FEATURE`, `AUDIENCE_TOO_SMALL`, `ACCOUNT_NOT_FOUND`, `ACCOUNT_PAYMENT_REQUIRED`, `ACCOUNT_SUSPENDED`)

**Idempotency (#1224)**
- `CreateMediaBuyRequest`, `UpdateMediaBuyRequest`, `SyncCreativesRequest`: add `idempotency_key` for safe retries after timeouts
- `CreateMediaBuyRequest.buyer_ref`: document deduplication semantics

**Media buy lifecycle (#1225)**
- `MediaBuyStatus`: add `rejected` enum value for post-creation seller declines
- `MediaBuy`: add `rejection_reason` field present when `status === rejected`

**Protocol version (#1226)**
- `GetAdCPCapabilitiesResponse.adcp.major_versions`: document that buyers MUST send `x-adcp-version` HTTP header on all requests

**Async polling (#1227)**
- `GetAdCPCapabilitiesResponse.media_buy`: add `polling` object (`supported`, `recommended_interval_seconds`, `max_wait_seconds`) for agents without persistent webhook endpoints

**Capabilities completeness (#1228)**
- `GetAdCPCapabilitiesResponse.media_buy`: add `async_tasks` list, `supports_proposals` flag, and `limits` object (`max_packages_per_buy`, `min_budget`, `min_flight_days`, `max_creatives_per_sync`)

**Package response (#1229)**
- `Package`: add `catalog` and `format_ids` fields echoed from the create request so agents can verify what the seller stored

**Signal deactivation (#1231)**
- `ActivateSignalRequest`: add `action: activate | deactivate` field with `activate` default; deactivation removes segments from downstream platforms to support GDPR/CCPA compliance

**Signal metadata (#1232)**
- `GetSignalsResponse` signal entries: add `categories` (for `categorical` signals) and `range` (for `numeric` signals) so buyers can construct valid targeting values

**Property list filters (#1233)**
- `PropertyListFilters`: make `countries_all` and `channels_any` optional; omitting means no restriction (enables global lists and all-channel lists)

**Content standards response (#1234)**
- `UpdateContentStandardsResponse`: replace flat object with `UpdateContentStandardsSuccess | UpdateContentStandardsError` discriminated union (`success: true/false`) consistent with all other write operations

**Forecast task (#1235)**
- New `get_forecast` task with `GetForecastRequest` and `GetForecastResponse` schemas; accepts `product_id`, `budget`, `start_date`, `end_date`, optional `targeting_overlay` and `optimization_goal`; returns a `DeliveryForecast` without requiring a full `get_products` call

**Performance feedback (#1236)**
- `ProvidePerformanceFeedbackRequest`: add `metric_value`, `metric_unit`, `measurement_provider`, `measurement_methodology`, `feedback_type` (`optimization_signal | correction | dispute`); deprecate `performance_index` in favor of `metric_value + metric_type`

**Creative assignments (#1237)**
- `SyncCreativesRequest.assignments`: replace ambiguous `{ creative_id: package_id[] }` map with typed array `{ creative_id, package_id, weight?, placement_ids? }[]`

**Batch preview (#1238)**
- `PreviewBatchResultSuccess`: add required `success: true`, `creative_id`, proper `response` object with `previews` and `expires_at`
- `PreviewBatchResultError`: add required `success: false`, `creative_id`, `errors: Error[]` (referencing standard Error schema)

**Creative delivery pagination (#1239)**
- `GetCreativeDeliveryRequest.pagination`: replace ad-hoc `limit/offset` with standard `PaginationRequest` cursor-based pagination
