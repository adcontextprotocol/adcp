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
- `reporting_profile` and `delivery_config_id` sites gain their named pattern. Webhook `token` sites gain a 4,096-character limit, suggestions gain a 1,000-character limit, and the `request_proposals` rejection `reason` gains a 2,000-character limit.
- The SLA window and creative review SLA `response_max` and `completion_max` reference `core/sla-duration.json`, which rejects `PT`, `P1DT`, and any other value ending in a bare `T`, because none is an ISO 8601 duration (#8905). It states the pattern of `core/iso8601-duration.json`. A zero bound such as `PT0S` stays valid.
- Trademark and brand claim `countries` require an uppercase ISO 3166-1 alpha-2 code, and the targeting modification selector `system` requires a postal system from `enums/postal-system.json`.
- `core/domain-name.json` states the RFC 1035 limits, 253 characters for the name and 63 for each label, so every domain name site gains them. `upstream_source_domain`, where `format: hostname` already set both limits, also requires a lowercase domain without a trailing dot.

**Looser, where the stricter copy rejected a published value:**

- 2 whole-number aspect ratios accept decimals, because `core/format.json` published `1.91:1`.

**Looser, because the named schema drops a rule:**

- `core/iana-timezone.json` drops its character pattern and its `not: {const: inventory_local}`. A timezone is a string of 1 to 255 characters that must resolve in the implementation's IANA Time Zone Database, and no value either rule rejected resolves there. The daypart `timezone` is the only site that accepts `inventory_local`, as a `const` branch beside the IANA identifier.

**Looser, so an origin survives a URL parser:**

- `core/https-origin.json` and the disclosed `attempted_agent_origin` accept one trailing slash, `^https://[^/?#@]+/?$` (#8923). A URL serializer writes an empty path as `/`, so `https://issuer.example` round-trips to `https://issuer.example/`, which the old pattern rejected. Receivers compare these values by canonical origin, so both spellings name the same origin.

**Planned for 4.0:**

- `core/iana-timezone.json` plans a 4.0 limit of 64 characters with `x-max-length-4.0: 64`, so every timezone site carries it. The longest IANA timezone identifier is 32 characters. 3.x keeps the `maxLength: 255` that 3.2.8 published.
- `core/https-url.json`, `core/https-origin.json`, and `core/webhook-url.json` plan a 4.0 limit of 2,048 characters with `x-max-length-4.0: 2048` (#8900), and 42 named ID schemas that state no length bound plan 255 with `x-max-length-4.0: 255` (#8899). Producers SHOULD stay within these limits now; 3.x validates neither.
