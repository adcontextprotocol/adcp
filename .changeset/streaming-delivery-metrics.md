---
"adcontextprotocol": minor
---

Add native streaming/audio metrics to delivery schema.

- Broadens `views` description to cover audio/podcast stream starts
- Renames `video_completions` to `completed_views` in aggregated_totals
- Adds `views`, `completion_rate`, `reach`, `reach_unit`, `frequency` to aggregated_totals
- Adds `reach_unit` field to `delivery-metrics.json` referencing existing `reach-unit.json` enum with `dependencies` co-occurrence constraint (reach requires reach_unit)
- Aggregated reach/frequency omitted when media buys have heterogeneous reach units
- Updates `frequency` description from "per individual" to "per reach unit"
- Training agent: channel-specific completion rates (podcast 87%, streaming audio 72%, CTV 82%), `views` at package level, audio/video metrics rolled up into totals, `reach_unit` emission (accounts for streaming, devices for CTV/OLV)
