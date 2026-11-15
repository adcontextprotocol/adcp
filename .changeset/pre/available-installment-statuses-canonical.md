---
"adcontextprotocol": minor
---

Move the experimental `available_installment_statuses` (`media_buy.installment_lifecycle`, #8116) from `core/reporting-capabilities.json` to `core/canonical-reporting-capabilities.json` (adcp#8501). The definition, `x-status: experimental` and `x-added-in: 3.3.0` are unchanged.

`core/reporting-capabilities.json` is used only by the deprecated `get_products` product, and 3.3 adds no field that exists only on a deprecated task. The canonical product's reporting capabilities, returned by `list_products`, `request_proposals` and `refine_proposals`, already carry `supports_installment_breakdown`, and the opened schema (DR-0036) now takes the status list beside it.

**This changes 3.3.0-beta.0 through beta.5.** The betas are immutable. A seller built from one declares `available_installment_statuses` on the canonical product's `reporting_capabilities` and stops sending it on a `get_products` product. The installment lifecycle docs and experimental status page say where it lives.
