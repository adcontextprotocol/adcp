---
---

Training agent: close sales_catalog_driven storyboard.

- **`sync_catalogs` accepts spec field name `type`** (was only accepting
  `catalog_type`), defaults to `product` when omitted, and accepts `url`
  as an alias for `feed_url`. Matches the v3 core/catalog.json schema.
  Also declares `brand`/`account` on `provide_performance_feedback`
  inputSchema so the SDK doesn't strip them.
- **`provide_performance_feedback` accepts `feedback` object as
  alternative to `performance_index`**: structured-feedback shape
  (`{satisfaction, notes}`) is common in practice and our declared
  inputSchema already allowed it; the handler now maps
  `satisfaction: positive/neutral/negative` to a derived numeric
  index (1.2/1.0/0.7) when the flat field is absent.

41/55 clean, 296 steps passing (was 40/55, 293).
