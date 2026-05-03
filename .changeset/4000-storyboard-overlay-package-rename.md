---
---

ci(storyboards): fall back to `@adcp/client` compliance cache path on 3.0.x (closes #4000)

The training-agent storyboard workflow's `Overlay in-repo compliance source onto SDK cache` step looked for the SDK's compliance cache only at `node_modules/@adcp/sdk/compliance/cache`. That path is the post-rename location used on `main`; on 3.0.x the package is still `@adcp/client` and the cache lives at `node_modules/@adcp/client/compliance/cache`.

The check silently skipped the overlay on every 3.0.x run (`SDK compliance cache not found under node_modules/@adcp/sdk/compliance/cache — skipping overlay`). With the overlay skipped, the storyboard runner read the SDK's frozen 3.0.0 snapshot — which doesn't carry the `fixtures:` block or `controller_seeding: true` flag those storyboards need. Pre-flight `comply_test_controller.seed_product` was never invoked, leaving 11 storyboards failing with `PRODUCT_NOT_FOUND` (or similarly-shaped seed-prerequisite errors): `sales_guaranteed`, `sales_broadcast_tv`, `media_buy_seller`, `media_buy_seller/delivery_reporting`, `media_buy_seller/governance_approved`, `creative_generative/seller`, `governance_delivery_monitor`, `governance_spend_authority`, `idempotency`, `brand_baseline`, `brand_rights`.

The forward-merge from `main` (which moved the path to `@adcp/sdk` in `5.23.0`) didn't get reverted on 3.0.x at the workflow level, even though the package dependency stayed pinned to `@adcp/client@5.21.1`. PR #3893 (admin-merged 2026-05-02) was the first 3.0.x PR that triggered this CI under the renamed path; the storyboard CI has been failing on 3.0.x since.

Fix: try the new path first, fall back to the old one. Both branches converge on a single workflow file that works regardless of which package the SDK is installed as. Local repro after the fix: 11/11 previously-failing storyboards pass (`sales_guaranteed ✓ 11P`, `sales_broadcast_tv ✓ 13P`, `brand_rights ✓ 6P`, `governance_delivery_monitor ✓ 12P`, `governance_spend_authority ✓ 9P`, all media_buy_seller scenarios `✓`, etc.).

Empty changeset — CI workflow change, no protocol surface affected.
