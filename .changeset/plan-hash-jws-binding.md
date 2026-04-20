---
"adcontextprotocol": minor
---

Add a `plan_hash` audit-layer claim to the `governance_context` JWS token that forever-binds each signed attestation to the plan state the governance agent evaluated. Closes #2455.

**What `plan_hash` is**

An audit-layer property — a cryptographic receipt that rides inside the JWS. `plan_hash = base64url_no_pad(SHA-256(JCS(plan_payload)))` over a single `plans[]` element at its current revision state, with a closed exclusion list for governance-agent bookkeeping (`version`, `status`, `syncedAt`, `revisionHistory`, `committedBudget`, `committedByType`). Canonicalization reuses RFC 8785 JCS — the same scheme as idempotency payload equivalence.

**What `plan_hash` is NOT**

It is not a wire-verification claim. Sellers do not verify it, are not expected to, and are not given a mechanism to. Plan payloads carry commercially sensitive buyer data (cross-seller allocations, per-seller caps, objectives, `approved_sellers` lists, custom policies, `ext`) that buyers do not share with sellers. There is no plan-retrieval mechanism in 3.x and none is planned. `plan_hash` is never listed in `crit`: `crit` gates wire verifiers, and no wire verifier processes this claim.

The seller verification contract is unchanged: the 15-step JWS checklist (authenticity, authorization scope, freshness). Sellers verify that a legitimate governance agent authorized this buyer to purchase this plan's action from them, in-date, not replayed. The plan itself stays opaque to sellers — as it should in any buyer/seller relationship.

**Who verifies `plan_hash`**

Three off-wire parties:

1. **The governance agent itself**: re-evaluates current plan state on every `check_governance` call (required on every spend-commit per #2403) and re-hashes. Tampering with its own persisted plan between calls surfaces as a mismatch against retained revision records.
2. **Auditors**: given access to plan state via `get_plan_audit_logs` and the governance agent's retained per-revision `plan_hash`, an auditor can prove "this attestation was over plan state X at time T" years after the fact. Forever-binding regulator-facing provenance.
3. **Buyer-side compliance**: a buyer's own tooling verifies its governance agent is producing tokens that match the plan the buyer actually pushed — catches a compromised or misbehaving governance vendor.

**Semantics live in the governance spec**

Canonicalization rules, excluded-fields list, retention obligations, test vectors, and the verification paths are specified in `docs/governance/campaign/specification.mdx` under "Plan binding and audit" — not in the security doc. `plan_hash` is a governance-audit property that happens to travel on a signed wire artifact; framing it as a security-profile concern conflates the two and mis-signals to implementers that it is part of seller verification.

The security doc's JWS profile still names `plan_hash` in the claim table (because it IS a claim the JWS carries) but reduces the entry to one sentence plus a pointer to the governance spec.

**Reference test vectors**

Ten vectors under `static/compliance/source/test-vectors/plan-hash/` pin the canonicalization bit-exactly: minimal, full, bookkeeping-stripped (identity-hash invariant), paired vectors proving omitted-vs-explicit-null, array-order, and ext-rotation all produce distinct hashes, and a Unicode case confirming JCS does not normalize per RFC 8785 §3.2.5.

**Migration**

- Governance agents: add SHA-256 + JCS + base64url computation on each sign. Retain per-revision `plan_hash` alongside existing revision records.
- Sellers: no change. Continue to persist and forward `governance_context` verbatim. The 15-step JWS verification checklist is unchanged.
- Auditors: recompute and verify using the existing `get_plan_audit_logs` access path plus the governance agent's retained records.
