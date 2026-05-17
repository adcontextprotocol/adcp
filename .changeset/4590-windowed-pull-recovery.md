---
"adcontextprotocol": minor
---

Windowed pull recovery on `get_media_buy_delivery` — closes [snapshot-and-log](docs/protocol/snapshot-and-log.mdx) Rule 4 for data-bearing events.

**Capability** (`core/reporting-capabilities.json`)
- New `windowed_pull_granularities` (array of `reporting-frequency` enum values). Capability-scoped MUST: sellers MUST honor `time_granularity` pulls at any granularity declared here. Sellers MAY emit higher-frequency webhooks than they pull (e.g., stream-tap webhook with warehouse pulls only at daily); buyers see the gap up front via the capability.

**Request** (`media-buy/get-media-buy-delivery-request.json`)
- New `time_granularity` (reporting-frequency enum: `hourly` | `daily` | `monthly`) and `include_window_breakdown` (boolean). When both are set, the response returns per-window delivery slices shape-aligned with `reporting_webhook` payloads at the same granularity.

**Response** (`media-buy/get-media-buy-delivery-response.json`)
- New `media_buy_deliveries[].windows[]` array. Each slice carries `window_start`, `window_end`, `totals` (delivery-metrics), optional `by_package`, `is_final`, and `measurement_window`. Slices are ordered ascending and contiguous over the requested date range. Buyers reconcile missed webhooks by joining on `(media_buy_id, window_start)`.

**Error code** (`enums/error-code.json`)
- New `UNSUPPORTED_GRANULARITY` for pulls outside the declared `windowed_pull_granularities`. Sellers SHOULD echo the supported set in `error.details.supported_granularities`. Recovery: correctable.

**Spec** (`docs/protocol/snapshot-and-log.mdx`)
- Rule 4 promoted from SHOULD to MUST for capability-declared granularities. The contract holds within the seller's declared parity set; honest declaration of asymmetric webhook-vs-pull frequencies is in scope.

Additive across the board: new request fields are optional, new response array is opt-in via `include_window_breakdown`, new capability defaults to empty (preserves current behavior — cumulative date-range pulls only). No breaking changes; safe in a minor release.

Closes #4590. Anchors snapshot-and-log Rule 4 alongside the existing transport-layer log surface ([#4278](https://github.com/adcontextprotocol/adcp/issues/4278)).
