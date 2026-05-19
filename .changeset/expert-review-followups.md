---
"adcontextprotocol": minor
---

spec: expert-review follow-ups on the 3.1 WG-review batch (#4399 / #4399b / #4107 / #4227 / #4371 / #2911).

Consolidated fixes from four-expert review (ad-tech-protocol-expert, adtech-product-expert, security-reviewer, docs-expert) of the 9-commit WG-review batch on this branch:

**Staged enforcement on universal idempotency_key.** Product expert flagged that a hard "MUST reject reads without idempotency_key" cliff at the 3.1 cut breaks hand-rolled integrators built via curl / thin MCP clients / OpenAPI codegen that doesn't include the field uniformly. Switched to staged: **3.1.0** sellers MUST accept reads carrying `idempotency_key` and SHOULD reject reads that omit it (MAY accept the omission during the 3.1.x maintenance window); **3.2.0** sellers MUST reject. SDK-using integrators (`@adcp/client`, `adcp-py`) are unaffected since both already send uniformly.

**Cache-at-rest encryption (security reviewer M2).** Universal `idempotency_key` from 3.1 means the cache holds account-scoped read responses (`get_products`, `list_accounts`, `list_creatives`, `get_signals`), not just write receipts. Added: sellers MUST encrypt the cache tier at rest with the same controls used for the underlying resource store, MUST NOT treat the cache as a transient retry-receipt store exempt from data-at-rest controls, and MUST scope reads by `(authenticated_agent, account_id)` at the storage layer (not just application layer).

**Forward-compatible decoding bounded by retry budget (security reviewer M1).** A receiver that literal-reads the new "default `transient` for unknown codes" rule and writes a retry loop without `maxRetries` could be DOS'd by a hostile sender emitting `code=GO_FOREVER, recovery=transient`. Added: the `transient` default is bounded by §Retry Logic (`maxRetries` + jittered exponential backoff); receivers MUST NOT loop indefinitely. Cross-link added from §Idempotency Buyer obligations to Forward-compatible decoding (the asymmetric link gap docs reviewer flagged).

**Stale `replayed.description` (flagged by both protocol and docs reviewers).** `core/protocol-envelope.json` still said "Only present on responses to mutating requests that carry idempotency_key" — contradicts both the universal-idempotency change and the replay-snapshot rule. Updated to: "MAY appear on responses to any request that resolved via the idempotency cache, including read tools".

**A2A serialization framing (protocol reviewer).** Envelope `notes` array described `task.artifacts[0].parts[].DataPart` and `task.status.message.parts[].DataPart` as symmetric, but `a2a-response-extraction.mdx` treats artifacts as canonical and `status.message.parts[]` as the fallback container only for interim states. Tightened to match the canonical/fallback framing and pinned the A2A version (0.3.0+).

**Cache-growth ceiling acknowledgment (protocol reviewer optional).** Rule 8's recommended 60/sec sustained ceiling was sized against a write-heavy launch pattern. Added a note that read traffic now contributes under universal idempotency and operators with read-heavy mixes SHOULD revisit the deployed ceiling at the 3.1 cut rather than accept silent `RATE_LIMITED` of legitimate reads. The numeric recommendations remain the right starting *shape*, not the right starting *magnitude*, when reads dominate.

**Mint `MULTI_FINALIZE_UNSUPPORTED` (protocol reviewer optional).** Protocol reviewer flagged that `INVALID_REQUEST` for a seller-side capability gap on multi-finalize ($refine[]$ atomicity) blurs "I can't support this combination" with "your request is malformed." Added `MULTI_FINALIZE_UNSUPPORTED` as the preferred code (`recovery: correctable`); `INVALID_REQUEST` remains acceptable for sellers on pre-3.1 error catalogs.

**3.1.0 release-notes — `Wire conformance` section + adopter-action table (docs reviewer).** The reach_window section was the only 3.1.0 entry; the spec changes from the WG-review batch were invisible to a 3.0→3.1 migrator reading release-notes. Added a new `### Wire conformance — idempotency & envelope tolerance` section covering all 8 spec changes plus an adopter-action table for the seven distinct integrator categories (SDK-using buyers, hand-rolled MCP clients, FastMCP/Pydantic/Zod sellers, sellers with synchronous-success state-tracking responses, agentic buyers reading `status` from mutations, sellers emitting unsigned webhooks or deprecated specialism claims, sellers emitting unknown error codes).

**`get_adcp_capabilities.mdx` idempotency block (docs reviewer consistency).** Stale "for mutating requests" framing on the capability description updated to reference the staged universalization and link to security.mdx.

**3.0→3.1 sender audit note (protocol reviewer optional).** `error.recovery` MUST-populate-from-3.1 rule is safe for buyers (they default to `transient` when absent) but sellers ratcheting `adcp_version` to 3.1 with un-audited error-emit code paths are non-conformant. Adopter-action table calls this out explicitly.

Files:
- `docs/building/by-layer/L1/security.mdx` — enforcement-curve paragraph, cache-at-rest paragraph, retry-bounded cross-link, rule-8 read-traffic acknowledgment
- `docs/building/by-layer/L3/error-handling.mdx` — `transient`-default bounded-by-retry sentence, `MULTI_FINALIZE_UNSUPPORTED` table row
- `docs/building/operating/transport-errors.mdx` — `MULTI_FINALIZE_UNSUPPORTED` recovery row
- `docs/protocol/get_adcp_capabilities.mdx` — idempotency block updated for staged universalization
- `docs/reference/release-notes.mdx` — new `### Wire conformance` section under 3.1.0 with adopter-action table
- `docs/media-buy/product-discovery/refinement.mdx` — `MULTI_FINALIZE_UNSUPPORTED` referenced, error table row added
- `docs/media-buy/task-reference/get_products.mdx` — `MULTI_FINALIZE_UNSUPPORTED` error table row
- `static/schemas/source/core/protocol-envelope.json` — `replayed.description` rewritten, A2A serialization framing tightened
- `static/schemas/source/enums/error-code.json` — `MULTI_FINALIZE_UNSUPPORTED` added to enum / enumDescriptions / enumMetadata (recovery: correctable)
- `scripts/error-code-drift-dispositions.json` — `MULTI_FINALIZE_UNSUPPORTED` held-for-next-minor / 3.1
- `static/schemas/source/media-buy/get-products-request.json` — multi-finalize description references the preferred code

Refs the eight prior commits in this WG-review batch.
