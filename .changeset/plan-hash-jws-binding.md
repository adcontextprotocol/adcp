---
"adcontextprotocol": minor
---

Bind `governance_context` JWS tokens to the attested plan state via a required `plan_hash` claim, closing the plan-mutation replay window identified in #2455.

#2455 surfaced the race: a governance agent signs over plan `v`, the plan is mutated to `v'`, the original JWS still verifies because nothing in the payload is tied to plan state. Particularly damaging for Annex III / Art 22 plans where `human_review_required` or regulated `policy_categories` could be stripped without invalidating the attestation.

**What changes**

- Governance agents MUST include `plan_hash = base64url_no_pad(SHA-256(JCS(plan_payload)))` in every compact JWS they emit under the AdCP JWS profile. Canonicalization reuses RFC 8785 JCS (same scheme as idempotency payload equivalence).
- The preimage is a single `plans[]` element at the plan-revision state the governance agent just evaluated, with a closed exclusion list for governance-agent bookkeeping (`version`, `status`, `syncedAt`, `revisionHistory`, `committedBudget`, `committedByType`).
- Governance agents that expose `audit_log_pointer` MUST retain the corresponding `plan_hash` alongside each internal plan-revision record so auditors can reconstruct which token attested to which revision.
- Governance agents MUST NOT cache and re-emit a previously-signed `governance_context` across plan revisions; each `check_governance` invocation produces a fresh signature bound to the current `plan_hash`.

**Who verifies the claim**

The governance agent itself and auditors — not sellers. Plan payloads are commercially sensitive (cross-seller allocations, per-seller caps, objectives, `approved_sellers`, custom policies, `ext`) and buyers do not share them with sellers. No plan-retrieval mechanism is specified in 3.x and none is planned. `plan_hash` is an audit-layer binding, not a wire-verification claim.

Three verification paths:

1. **Governance-agent self-verification**: on every `check_governance` (required on every spend-commit per #2403), the GA re-evaluates current plan state and re-hashes. Tampering with the GA's store between calls is detected by mismatch against retained revision records. Primary 3.x enforcement path.
2. **Auditor verification**: given access to plan state via `get_plan_audit_logs` and the GA's retained per-revision `plan_hash`, an auditor can recompute and verify any historical token against the plan state it attested to. This is the forever-binding property the signed format exists to deliver for regulators.
3. **Buyer-side compliance verification**: a buyer's own tooling can verify its GA is producing tokens matching the plan the buyer pushed — catches a compromised or misbehaving governance vendor.

`plan_hash` is required in the claim set but MUST NOT appear in `crit`. `crit` gates wire verifiers (sellers), and sellers cannot verify this claim at all. Listing it in `crit` would force sellers to reject tokens they have no basis to verify, with no offsetting benefit.

**Why this lands in 3.0 rather than being deferred**

Adding a security-semantic claim to a signed-token profile mid-3.x is a one-way door even when enforcement is offline. Deferring the claim to 3.1 would leave every token issued in 3.0 permanently unbindable to plan state — the audit property is most valuable when it applies retroactively to the entire 3.x corpus, so landing in 3.0 is what makes the forever-binding guarantee actually cover the forever. No ecosystem cutover is required: sellers already treat `governance_context` as opaque, and the claim is a forward-compatible addition they ignore.

**Enforcement bounds**

- Spend-commit paths: bounded by the seller's next `check_governance` per #2403 (sub-second happy path; worst case 15-minute intent-token `exp`).
- Modification and delivery phases: bounded by seller check cadence, worst case 30-day execution-token `exp`.
- Audit-time: unbounded. Every token is forever-bindable to the plan it attested to via the retained `plan_hash`.

**Reference test vectors**

Ten vectors under `static/compliance/source/test-vectors/plan-hash/` pin the canonicalization bit-exactly: minimal, full, bookkeeping-stripped (identity-hash invariant), paired vectors proving omitted-vs-explicit-null, array-order, and ext-rotation all produce distinct hashes, and a Unicode case confirming JCS does not normalize per RFC 8785 §3.2.5. Generator asserts paired invariants and fails on divergence.

**Migration**

- 3.0 governance agents: add SHA-256 + JCS + base64url computation on each sign. Retain per-revision `plan_hash` alongside existing revision records.
- Sellers: no change. Continue persisting and forwarding `governance_context` verbatim.
- Auditors: recompute and verify using the existing `get_plan_audit_logs` access path.
