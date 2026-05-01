---
"adcontextprotocol": patch
---

Fix `account.supported_billing` schema: require it only when `media_buy` is in `supported_protocols`, not unconditionally for all agents. Adds root-level `allOf` if/then guard following the existing `sync-plans-request.json` pattern. Non-media-buy agent authors should note that `supported_billing` was previously enforced on any `account` block — SDKs using code generators that drop draft-07 `if/then` (openapi-typescript, zod-to-json-schema, quicktype) should add a runtime guard to require `supported_billing` when `account` is present and `media_buy` is declared.
