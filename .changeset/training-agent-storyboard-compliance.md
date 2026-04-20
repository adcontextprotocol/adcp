---
---

Training agent: storyboard compliance pass on top of the 5.2 migration.

- **Runner brand injection.** `run-storyboards.ts` and `run-one-storyboard.ts`
  now resolve each storyboard's brand from its `prerequisites.test_kit` and
  pass it via `runStoryboard({ brand })`. Without this, the SDK's
  `applyBrandInvariant` is a no-op and bare steps land in
  `open:default` while branded writes land in `open:<domain>` —
  surfacing as `MEDIA_BUY_NOT_FOUND` on every read. Step pass count went
  from 0 → 208 once this landed.
- **Runner non-strict request validation.** Local monkey-patch of
  `SingleAgentClient.validateRequest` swaps `schema.strict()` for the default
  parse so tools whose schemas don't declare a top-level `brand` (e.g.
  `list_creative_formats`, `get_signals`, `sync_creatives`) tolerate the
  invariant injection. Required-field enforcement still works because
  schemas declare their own requireds. Filed as upstream issue against
  `@adcp/client`.
- **Session-keying preference.** `sessionKeyFromArgs` now prefers
  `brand.domain` over `account.account_id` in open mode. Storyboards mix the
  two shapes across steps in a single run; preferring brand keeps writes
  and reads on the same key.
- **Seven new creative formats** in `server/src/shared/formats.ts`:
  `broadcast_30s`, `broadcast_15s`, `ssai_30s`, `preroll_15s`,
  `native_feed`, `display_300x250_generative`, `video_30s_generative`.
  Channel map updated.
- **Governance findings + conditions on the wire.**
  `governance-handlers.ts` now surfaces `customPolicies` with
  `enforcement: 'must'` as both warning findings and binding `conditions[]`
  entries on proposed-binding checks; the delivery phase emits findings
  for `pacing` drift and overconcentrated `channel_distribution`. The
  `GOVERNANCE_DENIED` errors on `create_media_buy` and (newly enforced)
  `acquire_rights` carry `details.findings` so storyboards reading
  `field_present: findings` on the error envelope pass.
- **`handleAcquireRights`** now consults `session.governancePlans` and
  rejects with `GOVERNANCE_DENIED` when the rights price exceeds remaining
  authorised budget. Closes `brand_rights/governance_denied`.

After these changes: 208 storyboard steps passing (from 0 at the migration
baseline), ~25/54 storyboards fully clean. Remaining gaps tracked
separately:

1. Upstream `@adcp/client` SDK bug — `applyBrandInvariant` injects only
   top-level `brand`, never `account.brand`. Tools whose request-builders
   omit `account` (e.g. `get_media_buys`, `get_media_buy_delivery`) lose
   all scoping when the SDK strips the unrecognised top-level `brand`.
   Local workaround in the runner; fix belongs in the SDK.
2. Storyboard YAML bugs (filed upstream): `pending_creatives_to_start`
   sends `creatives[].content.media_url` instead of the schema-required
   `assets`; `sales_catalog_driven` sends `catalogs[].catalog_type`
   instead of `type`; `governance_spend_authority/*` and
   `governance_delivery_monitor` omit the schema-required `caller` on
   `check_governance`; `report_usage` in `creative_ad_server` sends a
   negative `performance_index` (spec requires ≥0).
3. Seeding gaps in the training agent: `creative_ad_server` references
   a creative `campaign_hero_video` not in the seed; `sales_non_guaranteed`
   references `mb_acme_q2_2026_auction`; `governance_spend_authority`
   references product `sports_ctv_q2`. These are training-agent
   convenience seeds, not protocol gaps.
4. `signed_requests` specialism (37 step failures) — RFC 9421
   transport-layer verification is a new capability the training agent
   doesn't implement yet. Out of scope for the 5.2 migration.
