---
"adcontextprotocol": minor
---

Sites that meant the same thing as a named schema, and stated a different constraint, now reference that schema (#8525). This changes what these sites accept.

**Tighter:**

- 41 timezone sites reference `core/iana-timezone.json`, including every `budget_cap_timezone`, the reporting `timezone` in `reporting_capabilities` and `get_account_financials`, and `supported_timezones`. They reject a value longer than 255 characters, a value outside the IANA identifier pattern, and `inventory_local`. The 10 that accepted an empty string no longer do.
- 10 `governance_context` request fields reference `core/governance-context.json` and reject non-printable characters.
- 8 `proposal_id` sites, 2 `catalog_ids` lists, and the wholesale feed signal `name` and `description` gain a length limit: 255 characters through `core/signal-name.json` and 2,000 through `core/signal-description.json`. `core/reporting-delivery-offering-id.json` lowers 3 `offering_id` limits from 255 to 128 and adds a pattern.
- `core/media-buy-id.json`, `core/account-id.json`, and `core/creative-evaluation-id.json` state `maxLength: 255`, so every site that references them gains it.
- `core/cancellation-reason.json` and `core/signal-description.json` state `minLength: 1`, so these values can't be empty anywhere. `core/account-request-id.json` states the ID pattern.
- `mraid_versions` in `get_adcp_capabilities` accepts `2.0` or `3.0`, the values of `enums/mraid-version.json`, instead of any MAJOR.MINOR.
- `reporting_profile` and `delivery_config_id` sites gain their named pattern. Webhook `token` sites gain a 4,096-character limit, suggestions gain a 1,000-character limit, and the `request_proposals` rejection `reason` gains a 2,000-character limit.
- Trademark and brand claim `countries` require an uppercase ISO 3166-1 alpha-2 code, and the targeting modification selector `system` requires a postal system from `enums/postal-system.json`.
- `core/domain-name.json` states the 253-character DNS limit, so every domain name site gains it. `upstream_source_domain` also requires a lowercase domain.

**Looser, where the stricter copy rejected a published value:**

- 2 whole-number aspect ratios accept decimals, because `core/format.json` published `1.91:1`.
