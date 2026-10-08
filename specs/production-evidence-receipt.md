# Production Evidence Receipt and Issuer Independence

**Status:** Draft for working-group review (AdCP 3.3, experimental)

**Related:** [#7068](https://github.com/adcontextprotocol/adcp/issues/7068),
[#2854](https://github.com/adcontextprotocol/adcp/issues/2854)

**Schema:** `static/schemas/source/core/production-evidence-receipt.json`

## Decision summary

An adopter should be able to answer "who has run which AdCP lifecycle in
production?" with dated, scoped evidence instead of a membership logo. This draft
defines only the part that is decidable now: the claims payload of a receipt and
the rules that stop one commercial network from certifying itself.

1. A receipt is a **claims payload** carried by the existing
   `AttestationReference` primitive. It adds no signing envelope, no trust store,
   and no new task.
2. `evidence_tier` is a ladder of what was observed. It is separate from
   conformance grading (AAO Verified) and is not a grade.
3. Independence is **declared and checkable**. The issuer MUST declare
   `issuer_counterparty_roles` and, from `independently_interoperable` upward, a
   `counterparty_relation`. A non-empty role declaration requires a co-signer
   that declared no roles. An empty declaration is a claim an evaluator backs
   with its own issuer policy, never proof by itself.
4. Conflict-of-interest and appeal rules are a published, digest-pinned policy
   (`issuance_policy`), not advisory prose.

Not in this draft: interviews, the Interchange prototype, the
AgenticAdvertising.org matrix, and the tier 1–2 registry extension. See
[Out of scope](#out-of-scope).

## Evidence ladder

| Tier | Where it lives | Meaning |
|---|---|---|
| `declared` | `adagents.json` / registry metadata (not a receipt) | The party says it implements AdCP. |
| `schema_validated` | Registry metadata (not a receipt) | Its messages validate against the published schemas. |
| `conformance_passed` | Receipt | Passed the storyboard harness for a version and transport in sandbox. Maps to AAO Verified `spec` evidence. |
| `sandbox_interoperable` | Receipt | Completed the stated tasks against a counterparty implementation in sandbox. |
| `independently_interoperable` | Receipt, independence rules apply | Interoperated with a counterparty that is not the issuer, the subject, or the protocol team. |
| `production_transacted` | Receipt, independence rules apply | A production MediaBuy was accepted through the stated task set. |
| `production_delivered_reconciled` | Receipt, independence rules apply | Non-zero delivery, reporting read back, and reconciliation completed. |

`conformance_passed` is the rung the issue omitted: the harness already exists,
and AAO Verified `spec` mode is its public form. AAO Verified `live` mode
(observed qualifying production traffic) is a producer of `production_transacted` and `production_delivered_reconciled` evidence under
this model, not a competing vocabulary.

Every receipt is scoped to one subject, one AdCP release, one transport, one
environment, a channel list, and an exact task set. It claims nothing outside that
scope. Receipts expire and are superseded rather than updated.

## Privacy defaults

The schema has no field for spend, price, campaign, client, or counterparty
identity, and `additionalProperties` is `false`. Volume is a coarse
`activity_band`. A party other than the subject may appear only in
`named_parties[]` with that party's own consent record. A subject approves a
public projection (`publication.visibility: public_projection`) while the issuer
retains the richer private record, pinned by `audit_record_digest`.

## Delivery and signing

The receipt is the claims payload. It is delivered as an `AttestationReference`
with `claim_type` `https://adcontextprotocol.org/claims/production-evidence/v1`,
resolved and verified under the evaluator's published `adcp.attestations`
capabilities and local trust policy. A reference to a receipt is a locator and a
hint, not proof.

This deliberately avoids a second JWS envelope for evidence claims. #2854 (AI
provenance) should converge on the same primitive, or on a documented profile of
it, before either locks a wire format. That coordination is open (see decision
brief).

The binding between payload and reference is part of the contract. Evaluators
MUST reject a receipt unless:

- the reference's `issuer`, `subject`, and `claim_type` equal the payload's
  `issuer`, `subject`, and `claim_type`;
- the verified credential protects the complete payload, including `co_signers`
  (the issuer vouches for who endorsed it);
- the credential's signed validity and revocation state are authoritative, and
  `expires_at` is never later than the credential's own expiry. Because a
  superseded or downgraded receipt stays cryptographically valid until it
  expires, an issuer that supersedes a receipt SHOULD also revoke its
  credential, and `expires_at` is the only freshness guarantee a reader can
  rely on without status access.

### Co-signer endorsements

A co-signer's `attestation` is its own credential, not a field in the issuer's
claim. It uses a separate claim type,
`https://adcontextprotocol.org/claims/production-evidence-endorsement/v1`, so an
auditor's own receipt cannot be replayed as an endorsement. Its subject is a
resource subject: `resource_type`
`https://adcontextprotocol.org/claims/subjects/production-evidence-receipt`,
`namespace` the receipt issuer's origin, `id` the `receipt_id`, and
`content_digest` equal to `sha256:` plus lowercase-hex SHA-256 of
`UTF8(JCS(receipt minus co_signers))`. Evaluators MUST recompute that digest.
Adding co-signers never changes what is endorsed.

The co-signer's roles are part of its signed credential. The `counterparty_roles`
in the receipt are a hint; evaluators MUST use the roles from the verified
credential and treat a mismatch as invalid.

## Independence rules

### Roles

`issuer_counterparty_roles` is required on every receipt. Values (shared with
co-signers):

- `subject_operator`: operates the subject.
- `subject_affiliate`: ownership, control, common control, revenue share, or an
  exclusive commercial arrangement with the subject's operator.
- `issuer_affiliate`: the same relationships with the receipt issuer. Meaningful
  for a co-signer.
- `transaction_counterparty`: a party (buyer, seller, or their agent) to the
  observed transactions.
- `network_intermediary`: carried, routed, brokered, or observed the transactions
  as a commercial intermediary.
- `compensated_by_issuer_or_subject`: paid by the issuer or the subject for the
  endorsement or the observation. Fees from a neutral pool or a pre-published
  schedule that neither controls do not count.

An empty array is the issuer's own assertion of none. Omission is invalid.
Evaluators MUST NOT infer independence from reputation, membership, or neutrality
claims. An issuer that sees AdCP calls because they pass through its own
infrastructure is a `network_intermediary` even when it adds no commercial
interest, because it is a counterparty in every transaction it observes.

### Requirements at `independently_interoperable` and above

Schema-enforced:

- `issuance_policy` and `counterparty_relation` are present.
- `issuer_counterparty_roles` contains only `transaction_counterparty` and
  `network_intermediary`. A subject operator or affiliate cannot reach these
  tiers.
- At `independently_interoperable`, `counterparty_relation` is `independent`.
  Production tiers may carry `affiliated` or `unknown`; a publication surface MUST
  show it, so a self-buy cannot present as independent production use.
- If `issuer_counterparty_roles` is non-empty, `co_signers` is present and at
  least one co-signer has `counterparty_roles: []`.
- `co_signers` is unique and holds at most 8 entries, because each is resolved
  and verified.

Evaluator-enforced (not expressible in JSON Schema):

- **Same principal.** "The issuer is not the subject" and "no co-signer is the
  issuer or subject" compare principals, not typed identities. Two identities are
  the same principal when their normalized origins are equal (an `agent_url` is
  reduced to its origin, a `brand` to its `domain`) or when either party's
  `brand.json` or `adagents.json` lists the other's agent. Ownership and
  common-control relationships are not mechanically detectable and live under the
  affiliate roles.
- **An empty declaration is a claim.** At `independently_interoperable` and above,
  an evaluator MUST NOT treat `issuer_counterparty_roles: []` as established
  independence unless its own accepted-issuer policy records the issuer as a
  non-participant, or the digest-pinned `issuance_policy` enumerates the issuer's
  roles and relationships. The allowlist the evaluator maintains, not the
  receipt, is the independence control. This is why the empty case needs no
  co-signer in the schema and why a public matrix MUST publish which issuers it
  accepts and why.
- Both the issuer and each co-signer MUST match the evaluator's accepted issuers.
- Temporal invariants: `last_observed_on` is not before `first_observed_on` or
  after `issued_at`; `expires_at` is after `issued_at`; evaluators SHOULD cap
  accepted `expires_at - issued_at` (for example at one year).
- `supersedes` MUST NOT contain the receipt's own `receipt_id` and MUST refer
  to receipts for the same subject and issuer.
- `issuance_policy.uri` is fetched only under the attestation fetch contract, and
  the evaluator ignores a receipt whose `issuance_policy.content_digest` does not
  match the bytes it fetches. "Published before the first receipt" is checkable
  only against an archive or transparency log; an evaluator SHOULD record the
  policy first seen.
- `audit_record_digest`, `consent_digest`, and the named-party consent are
  retained by the issuer and unverifiable from the receipt. Issuers SHOULD make
  the underlying record high-entropy (salted) so a digest cannot be brute-forced,
  and a named party equal to the issuer is invalid.
- An evaluator MAY require more than one co-signer or decline specific issuers by
  local policy.

### What a co-signer is

A co-signer has no role in the observed transactions, no ownership or commercial
dependency on the issuer or subject, and is not selected or paid by the subject
(see policy item 2). In practice that is an auditor or compliance runner that
reviews the retained audit record and endorses the claim. Two non-intermediary
counterparties attesting the same transaction (buyer-side and seller-side) is a
possible second route and is an open question below.

### What the ladder does and does not establish

The ladder mixes two axes: how real the environment is, and how independent the
counterparty is. `counterparty_relation` makes the second axis explicit so a
production tier is never read as independent corroboration by default. The
schema does not set a floor on `activity_band` or a minimum number of distinct
counterparties; evaluator and matrix policy may.

## Conflict-of-interest and appeal policy

An issuer of `independently_interoperable`-and-above receipts MUST publish an issuance policy at
`issuance_policy.uri` before issuing the first receipt it governs. The policy
MUST state at least:

1. The roles the issuer plays and its commercial relationships with subjects
   and with other issuers.
2. Who may be a co-signer and how co-signers are selected, such that the
   subject does not choose its own co-signer.
3. A published appeal path. A subject or a named party can dispute a receipt;
   the issuer acknowledges within a stated period and either supersedes or
   revokes the receipt, or states why not. Where the issuer declared non-empty
   `issuer_counterparty_roles`, an appeal MUST be decidable by a party other than
   the issuer.
4. Revocation: how status is published, using the attestation credential's own
   issuer-bound status.
5. That receipts are accepted from any issuer meeting the policy requirements, so
   no single network is the sole eligible issuer.

Any publication surface built from receipts (for example an
AgenticAdvertising.org implementation matrix) MUST show the issuer, its declared
roles, the scope, and the dates; MUST show a receipt as disputed while an appeal is
pending; and MUST NOT present a single issuer's receipts as certification by the
publisher.

## Worked shape

See `examples` in the schema. In short: a network intermediary observes two
production MediaBuys on a seller agent. It declares `["network_intermediary"]`
and `counterparty_relation: "independent"`, so the receipt needs a co-signer
with `[]` (an audit firm that reviewed the retained record), a published
`issuance_policy`, and subject consent for a public projection.

## Out of scope

- Interviews with Interchange and other adopters, the Interchange prototype, and
  the AgenticAdvertising.org matrix. These are human or product work.
- Tiers 1–2 as registry metadata. A declarative `implementation_evidence` block
  in `adagents.json` is a possible follow-up. It carries no independence rules,
  so it is separable.
- Any task, capability block, or endpoint for submitting or querying receipts.
- Revocation transport and key discovery for issuers. These come from the existing
  attestation primitives.

## Open questions

See the working-group decision brief on #7068:

1. Placement of tiers above `independently_interoperable` (and the receipt-vs-registry split for `conformance_passed`
   and `sandbox_interoperable`): registry metadata, an evidence service, or this
   protocol-level schema.
2. Whether a network that observes traffic it carries can ever be treated as
   independent, or is always a `network_intermediary` (this draft assumes the
   latter).
3. Pilot sequencing: launch with a published policy, one intermediary, and one
   structurally independent co-signer, or wait for a fuller multi-issuer governance
   model.
4. Whether two independent non-intermediary counterparties attesting the same
   transaction should also satisfy the independence rule.
5. Convergence of the signing profile with #2854.
