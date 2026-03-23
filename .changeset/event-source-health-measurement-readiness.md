---
"adcontextprotocol": minor
---

Event source health and measurement readiness for conversion tracking quality.

- **Event source health**: Optional `health` object on each event source in `sync_event_sources` response. Includes status (insufficient/minimum/good/excellent), seller-defined score, 24h event volume, and actionable issues. Analogous to Snap EQS / Meta EMQ.
- **Measurement readiness**: Optional `measurement_readiness` on products in `get_products` response. Evaluates whether the buyer's event setup is sufficient for the product's optimization capabilities. Includes ready flag, status, required/missing event types, and issues.
- New schemas: `event-source-health.json`, `measurement-readiness.json`, `event-source-health-status.json` enum
