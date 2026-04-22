---
"adcontextprotocol": major
---

Rename `refine[]` entity ids to `product_id` / `proposal_id` and make `action` optional (default `include`)

The `refine` array on `get_products` now uses prefixed id fields inside each scope branch — `product_id` under `scope: "product"` and `proposal_id` under `scope: "proposal"` — replacing the previous generic `id` field. This matches the id naming convention AdCP uses everywhere else in the protocol (`media_buy_id`, `plan_id`, `creative_id`, `account_id`, etc.).

`action` is now optional on product and proposal entries with a default of `"include"`. Orchestrators only need to set `action` explicitly for non-default behaviors: `"omit"` / `"more_like_this"` on products, `"omit"` / `"finalize"` on proposals.

The response `refinement_applied[]` changed to echo the matching id fields (`product_id` or `proposal_id`) instead of a generic `id`, so request and response use the same vocabulary. Each `refinement_applied` entry is now a discriminated union on `scope` (parallel to the request shape), and `scope` + the matching id field are required when the seller returns `refinement_applied`, making cross-validation a contract rather than a convention.

An OpenAPI-style `discriminator: { propertyName: "scope" }` annotation is now present on both request `refine[]` and response `refinement_applied[]`, so typed clients (TypeScript, Python/Pydantic) generate narrowed discriminated unions rather than anonymous flat unions.

Alongside the issue-named storyboard fixes, this sweep also removed one stale entry from `tests/storyboard-sample-request-schema-allowlist.json` (`specialisms/sales-proposal-mode/index.yaml#review_refine/get_products_refine`) that the lint surfaced once the schema was fixed.

**Migration from earlier 3.0 pre-releases:**

| Before | After |
|--------|-------|
| `{ "scope": "product", "id": "p1", "action": "include" }` | `{ "scope": "product", "product_id": "p1" }` |
| `{ "scope": "product", "id": "p1", "action": "include", "ask": "add 16:9" }` | `{ "scope": "product", "product_id": "p1", "ask": "add 16:9" }` |
| `{ "scope": "product", "id": "p1", "action": "omit" }` | `{ "scope": "product", "product_id": "p1", "action": "omit" }` |
| `{ "scope": "proposal", "id": "pr1", "action": "finalize" }` | `{ "scope": "proposal", "proposal_id": "pr1", "action": "finalize" }` |
| `refinement_applied: [{ "scope": "product", "id": "p1", "status": "applied" }]` | `refinement_applied: [{ "scope": "product", "product_id": "p1", "status": "applied" }]` |
