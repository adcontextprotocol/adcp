---
"adcontextprotocol": patch
---

fix(training-agent): validate event_source_id refs in create_media_buy + emit cost_per_acquisition in delivery

The training agent's `handleCreateMediaBuy` now rejects event-kind optimization goals whose `event_source_id` references were never registered via `sync_event_sources` (INVALID_REQUEST with `error.field` pointing at the offending JSONPath). Without this, the new `media_buy_seller/performance_buy_flow` storyboard scenario (#4642) silently passes phantom ids, defeating the anti-façade check.

`get_media_buy_delivery` totals now compute `cost_per_acquisition = spend / conversions` when both are positive, matching the delivery contract expected by the same scenario.
