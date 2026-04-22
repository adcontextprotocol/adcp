---
"adcontextprotocol": patch
---

Response schemas across property-list, collection-list, and governance families now accept the envelope-level `replayed` field that the seller's idempotency layer injects at response time.

Fifteen `*-response.json` schemas previously declared `additionalProperties: false` at the root, so AJV validators compiled from them rejected `replayed: true` / `replayed: false` — even though `docs/building/implementation/security.mdx` (the idempotency storyboard) requires sellers to emit it on mutating responses. This produced a two-faced contract where `create_media_buy` accepted the same envelope field (via branch-level `additionalProperties: true` on its `oneOf`) while `create_property_list`, `sync_plans`, and others did not. Media-buy, signals, creative, content-standards, and sponsored-intelligence responses already accept envelope-level fields through their `oneOf` branches and did not need changing — only schemas with a root-level seal were affected.

Affected schemas: property-list family (`create`, `update`, `delete`, `get`, `list`, `validate_property_delivery`), collection-list family (`create`, `update`, `delete`, `get`, `list`), and governance (`check_governance`, `get_plan_audit_logs`, `report_plan_outcome`, `sync_plans`).

Fix: root-level `additionalProperties` flipped to `true` on all 15 so envelope-level fields pass through. The eight mutating responses (`create_*`, `update_*`, `delete_*` × 2 families, `report_plan_outcome`, `sync_plans`) also declare `replayed: { type: boolean }` explicitly — consistent with how `context` and `ext` are declared today — so AJV still type-checks it. Nested body `additionalProperties: false` is left intact; envelope extensibility is a root-level concession, not a license for drift inside list bodies.

Regression coverage added in `tests/composed-schema-validation.test.cjs`: per-schema acceptance tests, a negative test (`replayed: "true"` as string must fail), a structural lint that walks every task-family `*-response.json` (including `oneOf`/`anyOf`/`allOf` branches) and fails on any sealed envelope without `replayed` declared, and a drift guard that asserts every inlined `replayed` description matches the canonical definition in `core/protocol-envelope.json`.

Resolves #2839.
