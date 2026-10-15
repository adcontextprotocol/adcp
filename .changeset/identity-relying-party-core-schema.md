---
"adcontextprotocol": patch
---

Move the `identity_relying_party` shape from `brand.json#/definitions` into a shared `core/identity-relying-party.json` schema. `brand.json` keeps `definitions/identity_relying_party` as a `$ref` alias, so existing references still resolve, and the experimental `trust/v1/trust.json` now references the core schema directly. No wire change.

The cross-file reference from `trust.json` into the root `brand.json` document (added in #8067) broke Python SDK type generation, which does not stage root discovery documents as reference targets. That failed the "Validate schema PR bundle" check for every schema PR, and for the release PR.
