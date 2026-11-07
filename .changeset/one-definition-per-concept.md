---
"adcontextprotocol": minor
---

Sites that meant the same thing as a named schema, and stated a different constraint, now reference that schema (#8525). This changes what these sites accept.

**Tighter:**

- 41 timezone sites reference `core/iana-timezone.json`, including every `budget_cap_timezone`, the reporting `timezone` in `reporting_capabilities` and `get_account_financials`, and `supported_timezones`. They reject a value longer than 255 characters, and the 10 that accepted an empty string no longer do. A value must resolve in the implementation's IANA Time Zone Database.
- 10 `governance_context` request fields reference `core/governance-context.json`, so `governance_context` is printable ASCII at every site, as 3.2.8's `core/protocol-envelope.json` published it. This is a correction under DR-0036: it applies the rule that 3.2.8 already published for the concept. 7 of these fields were in 3.2.8 without the rule; the other 3 are new in 3.3.
- 8 `proposal_id` sites, 2 `catalog_ids` lists, and the wholesale feed signal `name` and `description` gain a length limit: 255 characters through `core/signal-name.json` and 2,000 through `core/signal-description.json`. `core/reporting-delivery-offering-id.json` lowers 3 `offering_id` limits from 255 to 128 and adds a pattern.
- `core/media-buy-id.json`, `core/account-id.json`, and `core/creative-evaluation-id.json` state `maxLength: 255`, so every site that references them gains it.
- `core/cancellation-reason.json` and `core/signal-description.json` state `minLength: 1`, so these values can't be empty anywhere. `core/account-request-id.json` states the ID pattern.
- `mraid_versions` in `get_adcp_capabilities` accepts only `2.0` or `3.0`, the values of `enums/mraid-version.json`, instead of any MAJOR.MINOR. An MRAID version is 2.0 or 3.0 at every site, as 3.2.8's `html5` format published `mraid_version`. This is a correction under DR-0036: it applies the rule that 3.2.8 already published for the concept.
- `reporting_profile` and `delivery_config_id` sites gain their named pattern. Webhook `token` sites gain a 4,096-character limit, suggestions gain a 1,000-character limit, and the `request_proposals` rejection `reason` gains a 2,000-character limit.
- Trademark and brand claim `countries` require an uppercase ISO 3166-1 alpha-2 code, and the targeting modification selector `system` requires a postal system from `enums/postal-system.json`.
- `core/domain-name.json` states the 253-character DNS limit, so every domain name site gains it. `upstream_source_domain` also requires a lowercase domain.

**Looser, where the stricter copy rejected a published value:**

- 2 whole-number aspect ratios accept decimals, because `core/format.json` published `1.91:1`.

**Looser, because the named schema drops a rule:**

- `core/iana-timezone.json` drops its character pattern and its `not: {const: inventory_local}`. A timezone is a string of 1 to 255 characters that must resolve in the implementation's IANA Time Zone Database, and no value either rule rejected resolves there. The daypart `timezone` is the only site that accepts `inventory_local`, as a `const` branch beside the IANA identifier.

**Planned for 4.0:**

- `core/iana-timezone.json` plans a 4.0 limit of 64 characters with `x-max-length-4.0: 64`, so every timezone site carries it. The longest IANA timezone identifier is 32 characters. 3.x keeps the `maxLength: 255` that 3.2.8 published.
