---
"adcontextprotocol": patch
---

Every branch of a discriminated union states its tag's value as its `default`. Where a union's branches pin one property to a `const` (or a one-value `enum`), each branch now carries `"default"` equal to that value, beside the `const`. 529 tag properties in 147 unions gain the annotation. A table of `anyOf` value constraints, such as the country and postal-system pairs in `core/postal-country-system.json`, is a guard rather than a tagged union and gets no default. `default` is an annotation, so no payload's validity changes.

209 objects that stand for a concept of their own gain a `title` naming it, so generated types and docs name the concept instead of a path.

Geographic objects have one definition each under `core/`: `geo-coordinates`, `postal-address`, `geo-country-place-types`, `geo-region-countries` (with `geo-region-all-values-selector` and `country-subdivision-value-set`), `geo-proximity`, `metro-area`, `geojson-geometry`, `radius`, and `travel-time`. The `targeting_modification` postal-area selector references `core/postal-country-system.json` and takes its country/system pairing guard.

Ranges, durations, and money-like objects have one definition each under `core/`: `numeric-range`, `numeric-value-range`, `fixed-duration`, `closed-money`, `half-open-datetime-range`, `evidence-max-age`, `target-frequency`, `total-budget-guidance`, and `flight-endpoint`. The proposal `total_budget_guidance` requires `currency` and at least one of `min`, `recommended`, and `max`, as the canonical proposal does, and the `get_media_buy_artifacts` `time_range` requires `start` and `end`.

DOOH placement objects and pixel sizes have one definition each under `core/`: `pixel-size`, `dooh-address`, `dooh-location`, `dooh-screen-resolution`, and `render-dimensions`. Every pixel size rejects `unit`, and the `image_carousel` card size is open like the others.

Property identifiers and tag metadata have one definition each: `core/tag-metadata.json`, `core/tag-metadata-map.json`, `core/platform-independent-distribution-identifier.json`, and `core/distribution-identifier.json`. Property, placement, and test-controller identifiers reference `core/identifier.json` and take its domain and subdomain value rules.

Account and agent objects have one definition each under `core/`: `account-setup`, `account-change-resource`, `account-change-parent-ids`, `webhook-delivery-auth`, `buyer-agent-ref`, and `readiness-resource`. The account setup `url` is an `https` URL (`core/https-url.json`).

Brand, rights, and data-subject objects have one definition each under `core/`, including `contact`, `voice-synthesis`, `house-summary`, `rights-disclosure`, `data-subject-contestation`, and the brand claim definitions. The `brand.json` asset, fonts, logo, localized name, visual guideline, property, and brand agent definitions, with the `brand.json` definitions they reach, move to their own `core/brand-*.json` documents, which `brand.json` and the former copies reference. Contacts take `core/email-address.json`, and `get_brand_identity` takes the brand asset, logo, name, and visual guideline contracts.

Creative, preview, and format objects have one definition each, including `core/preview-input.json`, `core/creative-preview.json`, `core/format-params.json`, `core/component-assets.json`, and `a2ui/component-action.json`. The `build_creative` preview no longer requires `expires_at`, as `preview_creative` does not.

Signal and audience objects have one definition each under `core/`, including `signal-taxonomy`, `signal-modeling`, `signal-onboarder`, `reference-population`, `universal-id`, and `signal-catalog-entry`. A taxonomy value mapping's `taxonomy_value_id` is non-empty.

Optimization targets and trusted match objects have one definition each under `core/`, including `threshold-rate-target`, `optimization-event-source`, `keyword-match-capabilities`, and the trusted match filters. Event sources keep `custom_event_name` and `value_field` non-empty, and keyword capabilities list unique match types.

Delivery and reporting objects have one definition each under `core/`, including `media-buy-delivery`, `media-buy-delivery-totals`, `reporting-period`, `delivery-reporting-period`, `paged-delivery-breakdown-controls`, `metric-identity`, and `vendor-metric-key`. `media_buy_delivery` webhook `by_package` rows require `package_id`, `pricing_model`, `rate`, and `currency`, as `get_media_buy_delivery` rows do, and the audience and placement breakdown cursors are non-empty.

Media buy lifecycle objects have one definition each under `core/`, including `cancellation`, `accepted-proposal`, `io-acceptance`, `catalog-match`, `media-buy-submitted`, and `media-buy-failed-result`. Catalog match IDs and IO acceptance IDs take their named bounds, and the `build_creative` per-leaf `catalog_item_ref` requires `item_id`.

Governance and attestation objects have one definition each under `core/`, including `governance-finding`, `governance-delivery-statement`, `governance-delivery-metrics`, `governance-delivery-observation`, `plan-budget-summary`, and the attestation identity definitions. Retained delivery statements require `reporting_period`, and regulatory jurisdictions are ISO 3166-1 alpha-2 codes.

Content standards objects have one definition each under `core/`: `calibration-exemplars`, `calibration-url-reference`, `feature-check-result`, and `bulk-pagination`. Calibration URL languages are BCP 47 tags (`core/locale-tag.json`), and bulk pagination cursors are non-empty.

Sponsored intelligence objects have one definition each: `core/si-brand-agent-response.json` and `core/si-transaction-product.json`.

Task and error objects have one definition each under `core/`, including `task-error-response`, `task-response-body`, `error-details`, and the task list parts. The async working and submitted responses compose `core/compact-task-working.json` and `core/compact-task-submitted.json`, and the task status error code is a bounded open error code.
