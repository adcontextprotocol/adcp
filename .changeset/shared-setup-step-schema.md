---
"adcontextprotocol": patch
---

Extract the account `setup` next-step object into a shared `core/setup-step.json` (#8292). `core/account.json`, the `sync_accounts` response rows, and `core/principal-relationship.json` now `$ref` it instead of carrying three inline copies, and the shared schema states once that `url` and `message` are untrusted display data a client surfaces to a human and never fetches or executes. The shape is unchanged: same properties, same `required: ["message"]`, still open, so every payload valid before stays valid and nothing new validates. `core/reporting-delivery-config-state.json` keeps its own stricter `setup` (closed `action` enum, `https://` URL, bounded `message`, `additionalProperties: false`), because composing it would require re-listing every property under `additionalProperties: false`, so it stays separate.
