---
"adcontextprotocol": patch
---

No schema reaches into another schema document's internals. Every `$ref` names a whole document or a fragment of its own document, and `scripts/lint-schema-cross-document-refs.cjs`, which `test:schemas` runs, fails on any `$ref` whose fragment points into another document. No payload's validity changes.

The definitions and field schemas that other documents referenced by fragment are now documents of their own, and every user references the whole document. Each document that replaces a fragment code generators named is titled with that name, so no generated TypeScript type is renamed:

- Targeting fields, one document per field: `core/targeting-geo-countries.json` and `-geo-countries-exclude`, `-geo-regions` and `-geo-regions-exclude`, `-geo-value-labels`, `-geo-metros-exclude`, `-geo-postal-areas` and `-geo-postal-areas-exclude`, `-geo-places` and `-geo-places-exclude`, `-geo-proximity`, `-daypart-targets`, `-audience-include` and `-audience-exclude`, `-collection-lists` and `-collection-lists-exclude`, `-device-platform` and `-device-platform-exclude`, `-device-type` and `-device-type-exclude`, `-browser` and `-browser-exclude`, `-store-catchments`, and `-axe-segment`, with `core/age-restriction.json`. `core/targeting-input.json` and `core/product-offer-filters.json` reference them.
- Catalog filters: `core/catalog-item-ids.json`, `catalog-gtins`, `catalog-tags`, `catalog-category`, and `catalog-query`, which `core/catalog-selection.json` references.
- Product purchase fields: `core/budget-amount.json`, `core/daily-budget-cap.json`, `core/min-spend-target.json`, and `media-buy/product-purchase-format-option-refs.json`, `-catalog-ids`, `-start-time`, `-end-time`, `-optimization-goals`, `-audience-evidence-pins`, and `-performance-standards`, which `media-buy/product-purchase-input.json` references. Every `budget`, `daily_budget_cap`, and `min_spend_target` field with the same bounds references the first three.
- Version envelope fields: `core/version-envelope-adcp-version.json` and `core/version-envelope-adcp-major-version.json`, which the envelope and the 15 strict request schemas reference.
- Reporting aliases: `core/reporting-feed-purpose.json`, `reporting-media-buy-id`, `reporting-package-id`, `reporting-cloud`, `reporting-schedule-alignment`, and `media-buy/reporting-status-view.json`, which keep the titled aliases' names and compose their targets.
- Delivery and reporting: `core/dooh-delivery-metrics.json`, `core/viewability-metrics.json`, `core/standard-delivery-metric-aggregate.json`, `core/reporting-timezone-cutover.json`, `core/reporting-primary-key.json`, `core/reporting-reader-compatibility-item.json`, `enums/reporting-orchestration.json`, and the reporting subscription `account-exceptions`, `unauthorized-account`, and `prior-version` documents.
- Trackers: `core/vast-versions.json`, `core/daast-versions.json`, `enums/vast-tracker-event.json`, and `enums/daast-tracker-event.json`.
- Others: `media-buy/create-media-buy-success.json` (the `create_media_buy` success branch), `media-buy/product-field.json`, `core/account-change-origin.json`, and the trust.json `trust-acknowledgement`, `trust-domain`, `trust-grant-source`, `trust-namespaced-token`, and `trust-open-profiles` documents under `trust/v1/`.

A document that holds one field's schema carries that field's annotations. Where the target was an untitled alias of an existing document, such as `product_purchase.pricing`, users reference that document directly and keep the alias's annotations beside the `$ref`.
