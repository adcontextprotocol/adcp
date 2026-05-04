---
---

ci(storyboards): skip two SDK-blocked steps on /sales, ratchet floor

Two storyboard steps on `/sales` fail on framework-routed sellers due to SDK gaps that need upstream fixes. Adding both to `KNOWN_FAILING_STEPS` so the runner reports them as skipped (with the source-of-truth issue link) rather than failed.

**Step 1: `media_buy_seller/create_media_buy_async/create_media_buy_submitted`** — adcp-client#1554

The v5 `createMediaBuy` handler returns a hand-rolled `{ status: 'submitted', task_id }` envelope when the `force_create_media_buy_arm` directive is set. The v6 framework's projector rejects that shape (`from-platform.js:1438`) — the only way into the submitted arm is via `ctx.handoffToTask(fn)`, which assigns a framework-issued task_id. The test-controller directive requires the seller to return the **caller-supplied** task_id, so `handoffToTask` cannot satisfy the contract until the SDK exposes a `{ task_id }` overload.

**Step 2: `media_buy_seller/vendor_metric_accountability/get_delivery_with_vendor_metrics`** — adcp-client#1552

The SDK storyboard runner drops extension params (e.g. `vendor_metric_values`) from `comply_test_controller` requests before they reach the wire. The agent's `simulate_delivery` handler never sees the array, so the downstream `get_media_buy_delivery` assertion finds nothing on `by_package[].vendor_metric_values`. This is a pure runner gap — the spec declares `params` as passthrough.

Floor lift on /sales: 65→67 clean storyboards (each skipped step lets its parent storyboard count as clean).

| Tenant  | Old | New | Delta |
|---------|-----|-----|-------|
| /sales  | 65 / 252 | 67 / 252 | +2 / 0 |

Files: `server/tests/manual/run-storyboards.ts` (skip entries), `.github/workflows/training-agent-storyboards.yml`, `scripts/run-storyboards-matrix.sh`.

Once the upstream SDK fixes ship, drop the entries and ratchet the floor again.
