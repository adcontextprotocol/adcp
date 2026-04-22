---
---

Training agent: group C compliance wave 1 — three storyboards closed via
parallel-agent investigation, three upstream issues filed.

## Local fixes applied
- **`sales_social`** (`server/src/shared/formats.ts`) — add
  `product_carousel_3_to_10` format entry (spec-catalog format used by
  the DPA creative step). Matches the carousel shape documented in
  `docs/creative/channels/carousels.mdx`. Also added to
  `FORMAT_CHANNEL_MAP` to satisfy the test that enforces coverage.
- **`brand_rights/governance_denied`**
  (`server/src/training-agent/brand-handlers.ts`) — when a caller's
  `brand_id` matches no talent in our catalog, treat it as "no filter"
  rather than returning empty. Compliance runners inject the caller's
  account domain (e.g. `acmeoutdoor.example`) in that field, which
  otherwise strips downstream `$context.rights_id` extraction and
  prevents the governance-denial path from running at all.
- **`security_baseline`** (`server/tests/manual/run-storyboards.ts`,
  `server/tests/manual/run-one-storyboard.ts`) — serve a minimal RFC 8414
  auth-server metadata document at `/auth/.well-known/
  oauth-authorization-server`. The PRM handler already advertises this
  issuer; serving it makes the full RFC 9728 → 8414 chain resolvable.
- **Type-only fix** (`server/src/training-agent/task-handlers.ts`) —
  drop `asset_type: 'html'` from `buildHtmlAssets()`. `HTMLAssetSchema`
  in `@adcp/client` 5.9.x discriminates by slot name, not per-asset
  field. Pre-existing build break, surfaced post-merge.

## Upstream issues filed
- `adcp#2850` — `creative_fate_after_cancellation` storyboard YAML
  resolves `$context.creative_id` to undefined, stripping required
  `creatives[]`; fix by substituting the literal buyer-set id.
- `adcp#2851` — `deterministic_testing.force_creative_rejected`
  reuses an archived creative_id, directly contradicting the prior
  step's `invalid_creative_transition` assertion. Fix by splitting
  into two steps.
- `adcp-client#780` — storyboard runner's `list_creative_formats()`
  request-builder ignores `step.sample_request`, dropping
  `format_ids` filters. Blocks `media_buy_seller` substitution-observer
  assertion.

## Impact
Storyboard score: 43/56 → **45/56 clean**, 321 → **324 steps passing**.
Remaining Group C failures are upstream-blocked (the three filings).
