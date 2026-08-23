---
"adcontextprotocol": minor
---

Add `requested_metrics` to `get_media_buy_delivery`, giving the GET path the same metric narrowing the reporting webhook already has. Omitted means unchanged full payloads; impressions and spend are always included; requesting a leaf metric identity returns its canonical nested carrier; and `missing_metrics` MUST NOT flag absences caused solely by request narrowing. Implements RFC #6624.
