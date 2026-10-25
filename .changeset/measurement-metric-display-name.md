---
"adcontextprotocol": minor
---

Add an optional display `name` to measurement catalog metrics (`get_adcp_capabilities.measurement.metrics[].name`, 1–100 characters). Buyer agents and UIs SHOULD show it in place of `metric_id` and fall back to `metric_id` when absent. It is not an identifier: consumers MUST NOT match, key, or deduplicate on it, and `(vendor.domain, vendor.brand_id, metric_id)` stays the canonical reference. A name must contain a non-whitespace character and SHOULD be unique within one agent's catalog. Text search over `name` is permitted. Localized names are deferred.

The AgenticAdvertising.org registry carries `name` through its crawled `measurement_capabilities.metrics[]`, stripping invisible and bidi-override characters, rejecting names over 100 characters, empty names, and scriptish content, and collapsing whitespace to a single line.
