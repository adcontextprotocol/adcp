---
"adcontextprotocol": minor
---

spec(3.1): pre-GA clarifications batch #2 — five spec/docs items.

Five issues from the 3.1.0 milestone Cluster B + C work, plus four closed as already-shipped on inspection.

**Shipped in this batch:**

- **#4453 — `expires_at` optional on `preview-creative-response.json`.** Removed from `required` on all three branches (top-level + nested batch entries + variant branch); description updated to document the non-expiring case. Buyers MUST treat URLs as invalid after `expires_at` when present, MAY assume valid until out-of-band revocation when omitted. Note: AdCP 3.x has no protocol-level revocation signal — buyers requiring expiry guarantees SHOULD require sellers that publish `expires_at`.

- **#4567 — `account.account_financials` description sharpened as pre-call discriminator.** The field already existed at `protocol/get-adcp-capabilities-response.json:166`; description rewritten to make the buyer's pre-call-discriminator purpose explicit and to surface the companion-pattern relationship with `creative.bills_through_adcp`. No schema change; closing the issue with the rewrite as the answer.

- **#4578 — Version inference when `get_adcp_capabilities` is absent.** New paragraph in `versioning.mdx` § Bidirectional negotiation: buyers SHOULD infer v2 when the tool itself isn't on the seller's tool list, route through the v2 wire-shape adapter, emit a one-time advisory warning that retry-safety guarantees are unknown. Fail-open by design — failing closed blocks the most common adoption path (sellers that shipped v2 and never implemented v3 discovery). Buyers MUST NOT use absence as a positive v2 conformance signal; idempotency / signed-requests / other v3 trust primitives MUST be treated as unknown and gated at the application layer.

- **#4584 — `get_creative_delivery` pagination field-name normalization.** Added `total_count` (canonical, matches `PaginationResponse.total_count`) to the inline pagination block; marked `total` as deprecated alias with `deprecated: true`, removed in AdCP 4.0. Sellers populate both identically through 3.x; buyers SHOULD prefer `total_count`. Page-based pagination shape (`limit`/`offset`) retained — full migration to cursor-based `PaginationResponse` is a 4.0 candidate, not a 3.1 minor change. Description on the `pagination` block calls out the divergence and the migration timeline.

- **#3049 — Canonical rejection-set shape on `errors[].details`.** New SHOULD-level guidance under `core/error.json` `details` description: when reporting a rejected value against a closed accepted set, sellers SHOULD use `details.accepted_values` (array) + optional `details.rejected_value` rather than seller-specific variants observed in the wild (`available`, `allowed`, `accepted_values` at the error root). `details` remains `additionalProperties: true` — pre-3.1 sellers using legacy keys remain conformant. Safety carve-out: sellers MUST NOT enumerate ecosystem-wide accepted sets on a per-caller rejection (turns the error into an enumeration oracle). SDKs SHOULD accept any of the legacy variants and normalize on read; the canonical shape is what 3.1+ adopters should emit.

- **#4592 — Sponsored Placement adapter-contract docs.** New doc page at `docs/creative/sponsored-placement-adapter-contracts.mdx` documenting the four runtime contract families that ship under the single `sponsored_placement` canonical (Amazon SP buyer-uploaded, Criteo/CitrusAd network-composed, Pinterest/Snap Collection layout-per-impression, generative-per-SKU). Documents the catalog-asset contract, tracking vocabulary, adopter quirks, and `runtime_status` readiness per family. Linked from `canonical-formats.mdx` experimental-canonicals table. Not a spec extension; documents the variability buyers and sellers encounter against the canonical so the preview-until-evidence promotion gate is informed.

**Closed as already-shipped (no commit needed, will be closed via PR comments):**

- **#4400** — `start_time`/`end_time` asymmetry. The asymmetry is intentional at the spec level (you can `start` asap; you can't `end` asap — "end asap" means "cancel"). The structured-object form (`{type: "asap"}`) the issue's seller adopted is a non-spec extension; the spec is and remains string-only at `core/start-timing.json`. If WG wants to canonicalize the structured form for forward-extensibility, file an RFC; not a clarification.
- **#3555** — `pushNotificationConfig.url` port semantics. Already shipped: `core/push-notification-config.json:9-11` description plus `security.mdx:113-119` "Destination port: permissive by default" both exist with the unconstrained-by-default guidance.
- **#4466** — adagents.json `authorization_type` doc. Already shipped: `docs/governance/property/adagents.mdx:166` reads `*(required)*`.
- **#4574** — `list_authorized_properties` cleanup (and comment-expanded `list_audiences` / `list_targeting_categories`). Already shipped in main: `get_adcp_capabilities.mdx:957` has the migration section; `whats-new-in-v3.mdx` and `release-notes.mdx` carry the migration tables. The expanded-scope cleanup is implicit — `list_audiences` and `list_targeting_categories` have zero upstream references in `static/schemas/source/` or `static/compliance/source/`.
- **#4713** — 3.1 version negotiation docs surface. Already shipped in main: `whats-new-in-v3.mdx:346-348` covers version negotiation; `a2a-guide.mdx:912` and `mcp-guide.mdx:825` both updated for the release-precision contract.

Files:
- `static/schemas/source/creative/preview-creative-response.json` — `expires_at` optional on three branches, description updated
- `static/schemas/source/protocol/get-adcp-capabilities-response.json` — `account.account_financials` description sharpened
- `static/schemas/source/creative/get-creative-delivery-response.json` — `total_count` canonical + `total` deprecated alias
- `static/schemas/source/core/error.json` — `details` description gains canonical rejection-set shape SHOULD-guidance
- `docs/reference/versioning.mdx` — new paragraph on absence-of-`get_adcp_capabilities` v2 inference
- `docs/creative/sponsored-placement-adapter-contracts.mdx` — new doc page (four contract families)
- `docs/creative/canonical-formats.mdx` — link to the new adapter-contracts page

Closes #4453, #4567, #4578, #4584, #3049, #4592.
Closes #4400, #3555, #4466, #4574, #4713 (no code change; see PR comments).
