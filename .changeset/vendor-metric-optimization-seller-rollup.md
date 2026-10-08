---
"adcontextprotocol": minor
---

Add a seller-level `supported_metrics[]` rollup to `get_adcp_capabilities` `media_buy.vendor_metric_optimization`, mirroring the `supported_optimization_metrics` rollup. Each item is the product-level `vendor-metric-optimization-supported-metric` shape (`vendor` matched on `domain` and `brand_id`, `metric_id`, optional per-pair `supported_targets`), reused by `$ref`. Product-level declarations stay authoritative; sellers MUST keep the rollup in sync with their catalog (no pair listed unless at least one product supports it); omitting it means no guarantee and buyers fall back to per-product inspection. Buyers SHOULD check the rollup before sending a `vendor_metric` goal, including an `outcome_target` vendor goal, instead of learning an unsupported pair from `INVALID_REQUEST`. Additive and optional; the training agent derives the rollup from its catalog. Closes #4988.
