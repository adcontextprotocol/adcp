---
---

Add `docs/governance/policy-registry-sync.mdx` documenting the operational pattern for keeping campaign plans synchronized with the Policy Registry. Covers the headline question (`policy_ids[]` carries no version qualifier — so versions resolve at evaluation time, latest-wins), the inline-copy workaround for pinning a specific text into `custom_policies[]` under a renamed ID, behavior when a registry policy version-bumps mid-campaign, the `effective_date` staged-adoption pattern, sunset behavior, the additive-only invariant for inline policies relative to registry-sourced policies, and a working-group FAQ. Closes [#3140](https://github.com/adcontextprotocol/adcp/issues/3140). Pure descriptive doc — no schema, task, or protocol changes.
