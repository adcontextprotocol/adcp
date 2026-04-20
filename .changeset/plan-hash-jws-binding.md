---
"adcontextprotocol": minor
---

Establish the plan-mutation binding primitive on `governance_context` JWS tokens via a required `plan_hash` claim. Full seller-side enforcement arrives in 3.1; 3.0 emits the receipts so auditors and the governance agent itself can detect mutation immediately and so the 3.1 cutover needs no coordinated ecosystem migration.

#2455 identified the plan-mutation replay window — a governance agent signs `governance_context` over plan `v`, the plan is mutated to `v'`, the original JWS still verifies because nothing in the payload binds it to plan state. Particularly damaging for Annex III / Art 22 plans: `human_review_required: true` could be attested and then stripped without invalidating the attestation.

**What changes**

- Governance agents MUST include `plan_hash` — `base64url_no_pad(SHA-256(JCS(plan_payload)))` — in every compact JWS they emit under the AdCP JWS profile. Canonicalization reuses RFC 8785 JCS (the same scheme idempotency payload equivalence already uses).
- The preimage is a single `plans[]` element at the plan-revision state the governance agent just evaluated. A closed exclusion list strips governance-agent bookkeeping (`version`, `status`, `syncedAt`, `revisionHistory`, `committedBudget`, `committedByType`) — none of which are in the `sync_plans` request schema in the first place, but the list is stated explicitly so implementers naively hashing their internal state struct strip the right fields.
- Verifiers (3.1) MUST decode both sides to the raw 32-byte SHA-256 digest before comparing — string comparison of the encoded form is a footgun against padding/case/alphabet variation.
- Governance agents that expose `audit_log_pointer` MUST retain the corresponding `plan_hash` alongside each internal plan-revision record.
- Governance agents MUST NOT cache and re-emit a previously-signed `governance_context` across plan revisions; each `check_governance` invocation produces a fresh signature bound to the current `plan_hash`.
- In 3.0 `plan_hash` is opaque to sellers and MUST NOT appear in `crit`. 3.1 promotes it to `crit` and adds step 16 to the seller verification checklist (recompute and compare) alongside the plan-retrieval mechanism.

**Why this lands in 3.0 rather than being deferred**

Adding a security-semantic claim to a signed-token profile mid-3.x is a one-way door under the profile's own `crit` discipline. The three possible 3.1 paths all fail:

- **3.1 `plan_hash` with `crit`** — rejects every 3.0 verifier (per RFC 7515 §4.1.11, verifiers MUST reject unknown `crit` names). Breaks the ecosystem on a minor bump.
- **3.1 `plan_hash` without `crit`** — silent-downgrade-attackable: a MITM strips the claim, older verifiers accept the unmodified token, the binding is defeated.
- **Defer to 4.0** — 18+ months of exposed replay window on an experimental surface already in production.

Landing now as required-but-non-`crit` is the only path that preserves both forward compatibility and the `crit` contract. 3.0 verifiers ignore the unknown claim safely; 3.1 verifiers enforce it once the retrieval mechanism lands; no coordinated cutover.

**3.0 race-window scoping**

For spend-commit paths the window is bounded by the seller's next `check_governance` call per #2403's spend-commit invocation rule — the governance agent re-evaluates the current plan state and catches mutations at purchase time. Modification and delivery phases in the absence of an intervening seller-initiated check are bounded only by the token's `exp` (≤30 days for execution tokens). Receipt-only surfaces have no recomputation path in 3.0 and get full protection in 3.1. 3.0 is spend-commit-safe; post-hoc-audit-complete waits for 3.1.

**Migration**

- 3.0 governance agents: add a SHA-256 + JCS + base64url computation on each sign. No seller changes.
- 3.1 sellers: add step 16 (recompute and compare) once the plan-retrieval mechanism lands; governance agents move `plan_hash` into `crit` in the same release.
