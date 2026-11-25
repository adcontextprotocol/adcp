---
"adcontextprotocol": patch
---

Name repeated scalar subschemas (#8525). The currency code, country code, idempotency key, domain name, and HTTPS URL each move into a titled `core/` document, and the sites that stated them inline now `$ref` that document. Each site keeps its own `description` and other annotations. The same applies to every other scalar constraint that repeats, such as digests, versions, geographic codes, entity identifiers, numeric ranges, and enums: a constraint that repeats across documents moves to `core/` or `enums/`, and one that repeats inside a document moves to that document's `definitions`. A site moves only when the sites mean one concept and state identical constraints. There is no exception list: a site that means something else gets a named schema of its own. Apart from the two enum widenings in the separate changeset, no document's accepted set changes: `npm run test:schema-extraction` resolves every added `$ref` and compares the result with the base document.

The seller revision token that `account-change` `resource_revision` and `list_creatives` `seller_revision` share, a positive integer or a string, is `core/revision-token.json` (#8423). Both JSON types stay.

The legacy webhook `authentication` object has one definition per contract (#8907): `core/webhook-authentication.json`, with `credentials` required, for `push_notification_config`, `reporting_webhook`, and the `create_media_buy` `artifact_webhook`; and `core/notification-authentication.json`, with `credentials` optional, for account and agent notification configs, which are echoed on reads where credentials are write-only. Each site keeps `deprecated`, `x-removed-in`, and its description.

Ten inline `{start, end}` date-time objects, including the governance reporting periods and the `sync_plans` flight, reference the existing `core/datetime-range.json` (#8720).

Money has one definition, `core/money.json`: a non-negative amount and an ISO 4217 currency, both required (#8471). 14 inline copies reference it, including every media-buy `total_budget`, `build_creative` `max_spend`, the `check_governance` commitments, and account `credit_limit`. Commercial terms (closed) and plan adjustments (positive amounts) keep their own constraints.
