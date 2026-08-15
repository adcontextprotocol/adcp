---
"adcontextprotocol": minor
---

Add optional `delivery_date` support to `simulate_delivery` so compliance
storyboards can seed deterministic delivery rows and verify half-open
`get_media_buy_delivery` date filters. The training agent now aggregates dated
simulations within `[start_date, end_date)` while preserving cumulative behavior
for legacy undated simulations.
