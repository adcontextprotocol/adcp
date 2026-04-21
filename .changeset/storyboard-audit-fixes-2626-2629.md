---
---

Storyboard audit fixes surfaced in training-agent 5.7 adoption:

- **#2627 brand_rights**: `get_rights.sample_request` was passing the advertiser brand_id (captured from `get_brand_identity`) into `get_rights.brand_id`, which filters by rights-holder brand — a different entity. Dropped the mis-assigned `brand_id` and added `buyer_brand` so compatibility filtering works as spec'd.

- **#2628 double-cancel contradiction**: `state-machine.yaml > recancel_buy` previously said "either error or accept idempotently" with no assertions, while `invalid_transitions.yaml > second_cancel` already required `NOT_CANCELLABLE`. Aligned `recancel_buy` with the canonical `NOT_CANCELLABLE` vector — matches the §128/§129 resolution in #2619 (cancellation-specific code wins over generic terminal-state).

- **#2629 past_start any_of branches**: clarified optional-phase step grading in `storyboard-schema.yaml` and `runner-output-contract.yaml`. Steps in an `any_of` branch set whose peer phase contributed the aggregation flag MUST grade `not_applicable`, not `failed`. Prevents the non-chosen branch from surfacing as a hard step failure in runner summaries for conformant agents.

- **#2626 sales_catalog_driven test_kit**: storyboard is already spec-correct; the `feedback.satisfaction` payload comes from a hardcoded override in `@adcp/client`'s `request-builder.js`. Filed upstream at adcontextprotocol/adcp-client#689; no spec change required.
