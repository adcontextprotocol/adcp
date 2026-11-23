---
"adcontextprotocol": patch
---

No schema reaches into another schema document's internals. Every `$ref` names a whole document or a fragment of its own document, and `scripts/lint-schema-cross-document-refs.cjs`, which `test:schemas` runs, fails on any `$ref` whose fragment points into another document. No payload's validity changes.

The definitions and field schemas that other documents referenced by fragment are now documents of their own, and every user references the whole document:

- Targeting fields: `core/targeting-geo-countries.json`, `targeting-geo-regions`, `targeting-geo-value-labels`, `targeting-geo-metros`, `targeting-geo-postal-areas`, `targeting-geo-places`, `targeting-geo-proximity`, `targeting-daypart-targets`, `targeting-axe-segment`, `targeting-audiences`, `targeting-collection-lists`, `targeting-device-platforms`, `targeting-device-types`, `targeting-store-catchments`, `browser-families`, and `age-restriction`. `core/targeting-input.json` and `core/product-offer-filters.json` reference them.
- Catalog filters: `core/catalog-item-ids.json`, `catalog-gtins`, `catalog-tags`, `catalog-category`, and `catalog-query`, which `core/catalog-selection.json` references.
- Product purchase fields: `core/budget-amount.json`, `core/daily-budget-cap.json`, `core/min-spend-target.json`, and `media-buy/product-purchase-format-option-refs.json`, `-catalog-ids`, `-start-time`, `-end-time`, `-optimization-goals`, `-audience-evidence-pins`, and `-performance-standards`, which `media-buy/product-purchase-input.json` references. Every `budget`, `daily_budget_cap`, and `min_spend_target` field with the same bounds references the first three.
- Delivery and reporting: `core/dooh-delivery-metrics.json`, `core/viewability-metrics.json`, `core/standard-delivery-metric-aggregate.json`, `core/reporting-timezone-cutover.json`, `core/reporting-primary-key.json`, `core/reporting-reader-compatibility-item.json`, `enums/reporting-orchestration.json`, and the reporting subscription `account-exceptions`, `unauthorized-account`, and `prior-version` documents.
- Trackers: `core/vast-versions.json`, `core/daast-versions.json`, `enums/vast-tracker-event.json`, and `enums/daast-tracker-event.json`.
- Others: `media-buy/create-media-buy-success.json` (the `create_media_buy` success branch), `media-buy/product-field.json`, `core/account-change-origin.json`, and the trust.json `trust-acknowledgement`, `trust-domain`, `trust-grant-source`, `trust-namespaced-token`, and `trust-open-profiles` documents under `trust/v1/`.

The version envelope's `adcp_version` and `adcp_major_version` field schemas are `core/version-envelope-adcp-version.json` and `core/version-envelope-adcp-major-version.json`, which the envelope and the 15 strict request schemas reference. Where the target was a named alias of an existing document, such as the reporting `ReportingFeedPurpose`, users reference that document directly and keep the alias's annotations beside the `$ref`.
