---
"adcontextprotocol": patch
---

feat(training-agent): metric-mode forcing function for clicks / reach / completed_views storyboard scenarios

The training agent now declares seller-level `media_buy.supported_optimization_metrics` (the honest union across catalog products), validates `reach_unit` against the product's `metric_optimization.supported_reach_units` and `view_duration_seconds` against `metric_optimization.supported_view_durations` on `create_media_buy` (INVALID_REQUEST with literal JSONPath-lite `error.field`), and emits `cost_per_click` plus goal-gated `reach + frequency` / `completed_views + completion_rate` on `get_media_buy_delivery`. Flips three capability-gated storyboards (`clicks_buy_flow`, `reach_buy_flow`, `completed_views_buy_flow`) from `not_applicable` to applicable on the training agent. Same forcing-function shape as #4654 (event_source_id) and #4664 (audience_buy_flow / event_dedup_flow). Manual rollup declaration — adcp-client#1818's auto-derive remains blocked on the SDK exposing the seller-level field.
