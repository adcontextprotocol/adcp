---
"adcontextprotocol": minor
---

spec(brand): `account` on AcquireRights/UpdateRights + governance-bound CPM projection rule

Coupled spec gaps surfaced while validating a multi-tenant + multi-specialism hello adapter (per #3918):

1. **`acquire_rights` and `update_rights` accept `account: AccountReference`.** Governance-aware brand agents need brand+operator (or `account_id`) to look up any governance agent previously bound via `sync_governance`. The brand-rights compliance storyboard already sends `account: { brand, operator }` on the wire for `acquire_rights`, but the schema didn't define the field — adapters were falling back to `req.buyer.domain` (the brand, not the operator) for account resolution. `update_rights` had the same shape gap and is also a modification-phase governance trigger per the campaign-governance spec. Both fields are optional, follow the same shape `create_media_buy` uses.

2. **CPM-projection MUST broadened to cover the bound path on `acquire_rights`.** `acquire-rights-request.json` previously required `campaign.estimated_impressions` only when the request carried an intent-phase `governance_context` token AND the pricing option was CPM. Brand agents that resolve their governance binding via `sync_governance` (no inline token) still project CPM commitment — and "implementer-chosen defaults are non-conformant" applies equally there. The MUST now covers both paths: the request is governance-aware whenever an inline `governance_context` is present OR `account` resolves to an account with a bound governance agent. Non-CPM pricing options remain unaffected. The equivalent commit-delta projection rule for `update_rights` is left for a follow-up — it requires designing the delta semantics (impression_cap delta vs. pricing_option-switch delta) and is not yet normative.

3. **Inline-token-wins precedence.** When both an inline `governance_context` token and a bound governance agent are present on the same request, the inline token wins. The token is per-request, JWS-bound to a specific plan, and is the primary correlation key; the bound agent is the resolver fallback. Stated in the `account` field descriptions and in the `acquire_rights` task reference.

4. **`sync_governance` doc-comment clarifies account-scoped binding.** Adopters were reading the existing description as ambiguous on whether the binding could vary per plan inside the same account. The wire offers no field for per-plan governance agents (and `maxItems: 1` plus the singular `governance_context` envelope foreclose it). Description now states explicitly: binding is account-scoped, not plan-scoped; a single bound agent owns the lifecycle for every plan on the account; `plan_id` is threaded through `check_governance` for per-plan routing inside the bound agent, not at the registration layer.

Also fixes a stale anchor in the `acquire_rights` validation prose (`#buyer-side-governance-invocation` → `#spend-commit-invocation`).

Closes the wire-schema items on #3918 (`account` on acquire_rights/update_rights, broadened MUST, `plan_id` ambiguity). The two items deliberately not included: `plan_id` as a sync_governance field (conflicts with the documented account-wide binding), and loosened HTTPS pattern (better solved in the storyboard runner than by relaxing the wire spec).
