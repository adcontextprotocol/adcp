---
"adcontextprotocol": minor
---

Add an optional display `name` to measurement catalog metrics (`get_adcp_capabilities.measurement.metrics[].name`, 1–100 characters). Buyer agents and UIs SHOULD show it in place of `metric_id` and fall back to `metric_id` when absent. It is not an identifier: consumers MUST NOT use it to join, key, or deduplicate metrics, and `(vendor.domain, vendor.brand_id, metric_id)` stays the canonical reference. A name must contain a non-whitespace character and SHOULD be unique within one agent's catalog. Text search over `name` is permitted. Localized names are deferred.
