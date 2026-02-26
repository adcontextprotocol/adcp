---
"adcontextprotocol": minor
---

Add reach as a metric optimization goal and expand frequency cap capabilities.

**New metric optimization kind:**
- `reach` added to the `metric` enum on `kind: 'metric'` optimization goals
- `reach_unit` field — specifies the measurement entity (individuals, households, devices, etc.). Must match a value in `metric_optimization.supported_reach_units`.
- `target_frequency` field — optional `{ min, max, window }` band that frames frequency as an optimization signal, not a hard cap. `window` is required (e.g., `'7d'`, `'campaign'`) — frequency bands are meaningless without a time dimension. The seller de-prioritizes impressions toward entities already within the band and shifts budget toward unreach entities. Can be combined with `targeting_overlay.frequency_cap` for a hard ceiling.

**Product capability additions:**
- `metric_optimization.supported_reach_units` — declares which reach units the product supports for reach optimization goals. Required when `supported_metrics` includes `'reach'`.
- `reach` added to the `supported_metrics` enum in `metric_optimization`.

**Frequency cap expansion:**
- `max_impressions` — maximum impressions per entity per window (integer, minimum 1).
- `per` — entity to count against, using the same values as `reach-unit` enum (individuals, households, devices, accounts, cookies, custom). Aligns with `reach_unit` on reach optimization goals so hard caps and optimization signals stay in sync.
- `window` — time window for the cap (e.g., `'1d'`, `'7d'`, `'30d'`, `'campaign'`). Required when `max_impressions` is set.
- `suppress_minutes` is now optional (no longer required). The two controls (cooldown vs. impression cap) serve different purposes and can be used independently or together.
