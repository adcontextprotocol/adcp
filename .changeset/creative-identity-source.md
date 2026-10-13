---
"adcontextprotocol": minor
---

spec(creative): identify seller-created creatives and return seller IDs on reads. `list_creatives` already lists creatives created outside AdCP; the spec now says who assigns their `creative_id` and how a buyer tells the two kinds apart.

- New enum `creative-id-source` (`buyer` | `seller`). `list_creatives` `creatives[].creative_id_source` and `get_media_buys` `packages[].creative_approvals[].creative_id_source` report who assigned the ID. Sellers on 3.3 or later MUST include it on every row; absent means unknown.
- A seller MUST assign a `creative_id` to every listed creative that has no buyer-assigned ID: stable for the creative's lifetime, unique within the account, never equal to an ID a buyer has already used on the account, and MAY equal `platform_id`. Sellers SHOULD use a stable prefix and MUST NOT mint `revision_id` for seller-assigned creatives.
- A buyer manages a seller-assigned creative by syncing its `creative_id` as-is; this is an upsert under the normal active-delivery protection, and `creative_id_source` stays `seller`. A buyer sync that reuses a seller-assigned ID is an upsert of that creative (`action: updated`); buyers SHOULD namespace their IDs. `delete_missing` MUST NOT archive seller-assigned creatives.
- `list_creatives` `creatives[].platform_id` returns the seller's identifier for the creative after the `sync_creatives` response is gone. `assignment_platform_id` on `list_creatives` `assigned_packages[]` and `get_media_buys` `creative_approvals[]` carries the seller's identifier for a per-package object when the seller keeps one.

All new fields are optional in the schema, so 3.2 payloads remain valid. The `delete_missing` and seller-assigned ID rules narrow previously unspecified behavior.
