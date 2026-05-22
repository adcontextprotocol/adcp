---
"adcontextprotocol": minor
---

spec(errors): add `PROPOSAL_NOT_FOUND` to the canonical error catalog.

Counterpart to existing `PROPOSAL_EXPIRED` (known proposal whose `expires_at` window has passed) and `PROPOSAL_NOT_COMMITTED` (known proposal still in `draft`). `PROPOSAL_NOT_FOUND` covers the third proposal-lifecycle failure mode: the seller doesn't recognize the `proposal_id` at all — never finalized, belongs to a different tenant, or evicted from session cache before consumption.

Without this code, sellers had to reuse `INVALID_REQUEST` (loses semantics, wrong recovery class) or invent local codes (no cross-SDK consistency). The Python SDK's v1.5 ProposalManager (adcp-client-python#538) was shipping `PROPOSAL_NOT_FOUND` via its `KNOWN_NON_SPEC_CODES` allowlist as a stopgap, same pattern as `CONFIGURATION_ERROR` from #3995.

Recovery: `correctable` — buyer should re-issue `get_products` with `buying_mode: 'refine'` + `action: 'finalize'` to obtain a current `proposal_id`, then retry `create_media_buy`.

Files:
- `static/schemas/source/enums/error-code.json` — code added to `enum`, `enumDescriptions`, and `enumMetadata` (recovery + suggestion) per the three-parallel-structures convention.
- `scripts/error-code-drift-dispositions.json` — `held-for-next-minor` for target_version `3.1` (PROPOSAL_EXPIRED / PROPOSAL_NOT_COMMITTED are already on 3.0.x; PROPOSAL_NOT_FOUND is the new AHEAD code).
- `docs/media-buy/task-reference/get_products.mdx`, `docs/media-buy/product-discovery/refinement.mdx`, `docs/building/by-layer/L3/error-handling.mdx`, `docs/building/operating/transport-errors.mdx` — error-table rows alongside `PROPOSAL_EXPIRED`.

Closes #4043.
