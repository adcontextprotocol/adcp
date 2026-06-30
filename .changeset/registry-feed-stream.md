---
---

Registry: add `GET /api/registry/feed/stream` as the 3.x Server-Sent Events transport for cursor-based registry feed pages, with heartbeat events while caught up and reconnect recovery through the persisted cursor. `GET /api/registry/feed` responses now include required `freshness` metadata (`generated_at`, `latest_event_created_at`, `lag_seconds`, `retention_days`) so consumers can monitor mirror lag for their selected type filter. Freshness and feed queries are bounded to the 90-day retention window; SDKs should treat the SSE endpoint as the preferred transport and fall back to polling `/api/registry/feed`.
