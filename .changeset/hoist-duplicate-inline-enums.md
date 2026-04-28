---
"adcontextprotocol": patch
---

feat(schema): hoist 4 duplicate inline enum literal sets into shared `enums/` definitions (closes #3144)

Several inline string-literal unions in the AdCP source schemas had byte-identical value sets across multiple parent schemas but no shared `$ref`, causing the TypeScript SDK to emit per-parent duplicate exports (`Account_PaymentTermsValues`, `GetAccountFinancialsSuccess_PaymentTermsValues`, etc.) when a single canonical `PaymentTermsValues` is what consumers expect.

**New shared enum files added** (4 new `$id`-bearing schemas in `static/schemas/source/enums/`):

- `payment-terms.json` — `["net_15","net_30","net_45","net_60","net_90","prepay"]`
- `audio-channel-layout.json` — `["mono","stereo","5.1","7.1"]`
- `media-buy-valid-action.json` — `["pause","resume","cancel","update_budget","update_dates","update_packages","add_packages","sync_creatives"]`
- `rights-billing-period.json` — `["daily","weekly","monthly","quarterly","annual","one_time"]`

**Schemas updated to use `$ref`** (10 files; wire format unchanged in all cases):

- `core/account.json`, `account/sync-accounts-request.json`, `account/sync-accounts-response.json`, `account/get-account-financials-response.json` → `payment_terms` now refs `enums/payment-terms.json`
- `core/assets/audio-asset.json`, `core/assets/video-asset.json` → `channels`/`audio_channels` now ref `enums/audio-channel-layout.json`
- `media-buy/create-media-buy-response.json`, `media-buy/update-media-buy-response.json` → `valid_actions` items now ref `enums/media-buy-valid-action.json`
- `brand/rights-terms.json`, `brand/rights-pricing-option.json` → `period` now refs `enums/rights-billing-period.json`

**Not changed:** `core/insertion-order.json` `payment_terms` (`["net_30","net_60","net_90","prepaid","due_on_receipt"]` — different set, kept inline).

Non-breaking: replacing inline `{"type":"string","enum":[...]}` with a `$ref` to an equivalent standalone schema produces an identical JSON Schema subgraph; all existing validators behave identically. Source-schema refactor only; bundled wire format is unchanged — patch-eligible.

After a `npm run sync-schemas` in `adcp-client`, the SDK will emit single canonical exports (`PaymentTermsValues`, `AudioChannelLayoutValues`, etc.) and should ship deprecated re-export aliases for any per-parent names that were in a published release.
