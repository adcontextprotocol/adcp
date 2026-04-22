---
---

Storyboard fix: three `media_buy_seller` scenarios now thread `brand: { domain: "acmeoutdoor.example" }` on every session-scoped step's `sample_request`, instead of only on the opening `get_products` / `create_media_buy` steps.

Affected storyboards:
- `media_buy_seller/inventory_list_targeting` — `get_after_create`, `update_buy_swap_lists`, `get_after_update`
- `media_buy_seller/invalid_transitions` — `update_unknown_package`, `first_cancel`, `second_cancel`
- `media_buy_seller/pending_creatives_to_start` — `sync_creative`, `assign_creative_to_package`, `get_media_buy_after_sync`

Without this, the later steps landed in `open:default` while the `create_media_buy` step wrote to `open:acmeoutdoor.example`, so any seller that scopes session state by brand (spec-required for multi-tenant isolation) correctly refused to return the buy and the storyboard scored it as a failure.

Unblocks end-to-end verification for the collection-list CRUD complaint in adcontextprotocol/adcp#2236 (training-agent server handlers were always correct — the test harness was asking the wrong session). Latent CLI bug in the runner filed as adcontextprotocol/adcp-client#637: `adcp storyboard run <agent> --file <path>` doesn't strip the file path from positional args, so a local YAML edit can't currently be verified end-to-end via the CLI.
