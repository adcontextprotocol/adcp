---
"adcontextprotocol": patch
---

Add schema link checker workflow for docs PRs. The checker validates that schema URLs in documentation point to schemas that exist, and warns when schemas exist in source but haven't been released yet.

Update all v1 schema URLs to v3 across documentation:
- `docs/protocol/get_adcp_capabilities.mdx`
- `docs/accounts/tasks/get_account_financials.mdx`
- `docs/accounts/tasks/sync_accounts.mdx`
- `docs/creative/catalogs.mdx`
- `docs/creative/task-reference/build_creative.mdx`
- `docs/reference/migration/channels.mdx`
- `docs/reference/migration/pricing.mdx`
- `docs/reference/migration/geo-targeting.mdx`
- `docs/reference/migration/creatives.mdx`
- `docs/reference/media-channel-taxonomy.mdx`
- `docs/media-buy/task-reference/sync_audiences.mdx`

Some of these schemas are already released in v3, others will be available in the next beta release (3.0.0-beta.4).
