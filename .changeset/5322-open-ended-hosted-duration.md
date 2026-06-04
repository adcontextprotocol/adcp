---
"adcontextprotocol": minor
---

schema: allow hosted audio/video duration ranges to omit one endpoint.

Hosted `duration_ms_range` now supports one-sided ranges such as `[null, 60000]`
for "up to 60 seconds" and `[15000, null]` for "at least 15 seconds", while
rejecting `[null, null]`. This keeps duration constraints to two mechanisms:
`duration_ms_exact` for fixed durations and `duration_ms_range` for bounded or
one-sided ranges.
