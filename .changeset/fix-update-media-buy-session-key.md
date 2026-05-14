---
---

fix(training-agent): update_media_buy on cancelled buy returns INVALID_STATE not MEDIA_BUY_NOT_FOUND

Closes #4083. The v6 `SalesPlatform.updateMediaBuy` wrapper was missing the
`brand_domain` session-key threading that `syncCreatives` already carries. The
v6 SDK resolves `account.brand.domain` into `ctx.account.ctx_metadata.brand_domain`
but does not re-inject it into the `patch` object, so `sessionKeyFromArgs` in
the v5 handler resolved to `open:default` while the buy lived in
`open:<brand-domain>`. The `pause_canceled_buy` storyboard step therefore got
`MEDIA_BUY_NOT_FOUND` instead of `INVALID_STATE`.

**Changes:**

- `v6-sales-platform.ts`: extract `brandDomainFromCtx` helper; thread
  `brand.domain` into args for `updateMediaBuy`, `getMediaBuyDelivery`,
  `getMediaBuys`, and `listCreatives`; use the helper in the existing
  `syncCreatives` fix to remove the inline copy.
- `task-handlers.ts`: remove unreachable secondary re-cancel guard inside
  `handleUpdateMediaBuy` (lines 2726-2733) that returned `INVALID_STATE`
  on a re-cancel instead of the required `NOT_CANCELLABLE`. The primary
  terminal-state check at line 2703 already handles re-cancels correctly
  before this branch could ever execute; the dead code was a latent
  spec-violation if the invariant were ever relaxed.
