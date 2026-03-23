---
"adcontextprotocol": minor
---

Event source health and measurement readiness for conversion tracking quality.

- **Event source health**: Optional `health` object on each event source in `sync_event_sources` response. Includes status (insufficient/minimum/good/excellent), seller-defined detail, match rate, evaluated_at timestamp, 24h event volume, and actionable issues. Analogous to Snap EQS / Meta EMQ — sellers without native scores derive status from operational metrics.
- **Measurement readiness**: Optional `measurement_readiness` on products in `get_products` response. Evaluates whether the buyer's event setup is sufficient for the product's optimization capabilities. Includes status, required/missing event types, and issues.
- New schemas: `event-source-health.json`, `measurement-readiness.json`, `diagnostic-issue.json`, `assessment-status.json` enum
