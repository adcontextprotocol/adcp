---
---

Surface measurement-vendor discovery in the registry docs. Closes #3503.

The federated agent index already supports `GET /api/registry/agents?type=measurement` — that's the existing answer to "which vendors offer measurement?" The docs now call this out explicitly with a measurement-vendor subsection that links to the [vendor-metric extensions surface](/docs/media-buy/media-buys/optimization-reporting#vendor-defined-metrics) and explains the buyer-agent use case.

The full ask in #3503 (per-metric catalog + category aggregation) requires a brand.json schema decision about where the per-metric list lives. That's split out as #3586 (needs WG signal) — the schema work is decoupled from this docs surfacing.
