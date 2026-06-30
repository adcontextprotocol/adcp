# RFC: Graduate the Property Catalog (Draft → normative, non-authoritative)

**Status**: Draft (RFC)

## Summary

`specs/property-registry-catalog.md` describes a fact-graph catalog that already
embodies the right answer for referential identity (layer 2) and boundary
(layer 4) of [property-definition alignment](./property-definition-alignment.md).
It is marked **Draft** and several pieces live only in prose. This RFC proposes
**graduating it to normative-but-non-authoritative**: making `property_rid` a
real protocol type, pinning the claims/rank/alias fact model, writing the
boundary rubric as a normative-but-fallback-only rule, and adding the missing
ontology-evolution process. It resolves the catalog spec's open questions #3 and
#4.

It changes **no authoritative wire surface**: adagents.json / brand.json remain
the origin-rooted authority for what exists and who may sell it. Everything here
is the non-authoritative convergence layer that sits *beside* the origin.

## Motivation

- Layer 2 (is X the same as Y?) and layer 4 (is ESPN one property or four?) have
  no normative home today — they live in a Draft doc and in Scope3's internal
  graph. TMP context-match needs a stable shared join key (`property_rid`).
- The one genuine layer-1 (ontology) gap is process: there is no documented gate
  for extending `property_type` / `identifier-types` (closed enums consumers
  branch on). Without it, the enums either freeze or fragment.
- #5750/#5752 closed the authority layer; this is the next layer down.

## Proposal

### 1. `property_rid` becomes a protocol type — non-authoritative by construction

- UUID v7, globally unique, **forever-stable**, alias-on-error (never reused).
- **A non-authoritative surrogate.** `property_rid` is a join/scope key — and
  today it *is* the per-property scope key in `catalog_agent_authorizations`
  (`specs/registry-authorization-model.md`) — but it **confers no authority**.
  Whether an authorization is real is carried by its `evidence` value
  (`adagents_json` = origin-rooted), never by the rid. The normative rule: a rid
  never *upgrades* trust — a `community`/`agent_claim` row keyed to a rid is no
  more authoritative for it. Authority is anchored to origin domain control, not
  the catalog surrogate. (The risk to guard is the rid being *read* as an
  authority handle — the same way the AAO mirror could be mistaken for a
  registrar.)
- On the wire, `property_id` stays publisher-scoped; `property_rid` is the
  catalog's surrogate, surfaced for discovery and matching.

### 2. The fact model is normative

- Every catalog assertion is a **claim** carrying its source/trust signal,
  `actor`, `provenance`, `timestamp`, and **a citable reference** — never a bare
  assertion (this is what keeps the `community` tier auditable).
- **Two trust axes, not one ladder** (`specs/registry-authorization-model.md`):
  authorization rows carry `evidence ∈ {adagents_json, agent_claim, community}` —
  there is **no separate confidence column**; `evidence` *is* the trust signal
  (`adagents_json` authoritative-by-definition, the other two non-authoritative,
  snapshot defaults to `adagents_json`-only). Identifier *linking* carries the
  separate `confidence ∈ {authoritative, strong, medium, weak}` scale. A
  non-authoritative signal may corroborate or dispute an authoritative one but
  **never override** it. Origin-verification (the adagents.json crawl, and the
  #5752 claim-bind) is the only automatic contributed→authoritative promotion
  path. A new trust tier (e.g. signed cross-attestation, §5) is added as a **new
  `evidence` value**, per that spec's extension guidance — not by inserting a
  rung into a fabricated single ranking.
- **Contested records coexist, not edit-warred.** Today this is a binary
  `disputed` boolean on authorization rows. This RFC *proposes moving toward* a
  graded rank for the catalog's identifier-linking layer (Wikidata
  preferred/normal/deprecated) so contradictory links coexist with an ordering
  rather than overwriting — a proposal, not current state.
- **Auto-link only** on authoritative evidence (a publisher's own adagents.json
  declaring multiple identifiers under one `property_id`) or same-app app-store
  evidence. Everything weaker (dns, member_assertion, addie_analysis) requires
  corroboration or human review.
- **Reversible by alias.** Merges leave the old rid as an alias that keeps
  resolving; splits create new rids and preserve the original. No destructive
  deletes.

### 3. Boundary is owner-declared (declare-don't-derive)

- The partition of identifiers into properties is **whatever the domain
  controller declares** in its own adagents.json. CNN declaring `cnn_web` and
  `cnn_ctv_app` is two properties, full stop; same developer ≠ same property.
- Promote the catalog's one-sentence rubric to **normative but fallback-only**:
  "a property is a single addressable surface where content lives and ads can
  appear; one property, one rid, many identifiers." The graph applies this
  heuristic **only in the absence** of an origin declaration, mints a single
  **provisional** rid (flagged), and **splits** it losslessly when an origin
  declaration is later discovered (the original rid persists; declared
  sub-properties get new rids with a `part_of` edge).
- **ESPN is a tree, not a node:** a parent network rid with child surface rids
  joined by `part_of`. Buyers target the parent (whole tree) or a leaf.
- Boundary disputes resolve through the same evidence/rank/disavow machinery as
  referential identity — **never** a registry adjudication. A domain controller
  may always SPLIT/DISAVOW unilaterally; no party may MERGE across a declared
  boundary or CLAIM another's property.

### 4. Ontology evolution (the layer-1 gap)

Keep `property_type` (10 values) and `identifier-types` (21 values) as **closed**
leaf enums — consumers branch on them. Add a documented lifecycle:

- A new value enters via a **low-ceremony additive RFC PR** (schema.org / W3C
  community-group style), ships on a versioned minor with a **crosswalk note**.
- **Graduation gate (new WG policy — there is no documented enum-evolution gate
  today):** a candidate must show running-code demand — at least N independent
  implementers already expressing the concept via `tags` + `supported_channels`
  before it earns an enum slot. (Proposed N = 3.)
- **Deprecate, never delete** retired values.
- `tags` stay **publisher-local** (not a global taxonomy) and `supported_channels`
  is the soft-typing escape valve — an emerging type a publisher needs but the
  enum lacks is expressed via channels+tags, and a recurring pattern is the
  signal to graduate it. Resist "enum the corpus."

### 5. Cross-publisher sameness via signed attestation

This is **not a new mechanism** — it is the realization of the path already
identified-and-deferred in `specs/registry-authorization-model.md` ("the v3 fix
for the cross-publisher case requires either signed cross-attestation or a
corroborating publisher-side claim; deferred"). For the cross-publisher case the
writer refuses today (agent X claims it may speak for publisher Y), publisher Y
issues a **signed cross-attestation**: a VC-style credential chained to Y's
`jwks_uri` / `did:web` key. The verifier accepts it on the strength of the
signature (domain-rooted) and records it as a **new `evidence` value**
(`signed_attestation`) — exactly the extension path that spec prescribes ("if a
future evidence source needs a separate trust gradation, add it as a new
`evidence` value"), not a parallel scale. This generalizes the established
seller-publishes / buyer-represents / seller-confirms provenance-verifier pattern
from authorization to identity. Verifier trust policy stays explicit (snapshot
defaults to `evidence=adagents_json`); the attestation never overrides a
conflicting origin declaration.

## Resolved open questions (from the catalog spec)

- **#3 (linking without adagents.json):** introduce a `candidate_edges` table for
  proposed-but-unexecuted sameness (`said_to_be_same_as`) that lacks ≥ strong
  evidence. Resolution ignores candidates; a second corroborating source or a
  signed attestation auto-promotes; genuinely-contested cross-publisher claims
  route to human review. Never auto-merge below `strong`.
- **#4 (domain re-registration / staleness):** time-limited *catalog facts*
  carry an `expires_at`; authoritative *authorization* rows instead refresh on
  every successful crawl and **soft-delete** when the manifest stops declaring
  them (`registry-authorization-model.md` — `adagents_json` rows have no TTL).
  Either way, a domain that stops serving its file, or changes hands, lets its
  authoritative state **lapse to next-best** (never delete — the rid is forever;
  deactivate via `classification_changed`/`ownership_changed`, mint a new rid,
  alias the old). This is the same re-verify-and-lapse mechanism the
  bind-on-verify ownership model needs (#5752 follow-up) — one shared contract.

## Non-goals / out of scope

- No change to authoritative authorization (adagents.json stays sole source;
  scores stay private; property lists stay buyer-private).
- No central registrar. The graph is non-authoritative; the operator is
  load-bearing only for *materialization*, and the math (append-only facts +
  rank ordering + UNIQUE constraint + alias chain) is independently recomputable.
- Full append-only Merkle-provability of the change-feed is a later major; ship
  monitorability first (see the alignment framing doc).

## Amends to the catalog spec

- **Design Principle #6** (`property-registry-catalog.md` — "the registry IS the
  authoritative declaration" for fileless properties) is **restated**: the
  registry may be the *identity* record-of-last-resort for a fileless property
  (community tier), but it is **not** authoritative for sales authorization
  (`authorized_agents` stays `[]`) and is instantly superseded by an origin file.
  "Authoritative" in Principle #6 means identity/listing-of-last-resort, never
  authority-to-sell.
- Open questions #3 and #4 are resolved above and should be struck from the
  catalog spec when this RFC lands.

## Migration & versioning impact

- **Target: a 3.2 minor — additive, no breaking wire change.**
- **Already on the wire:** `property_rid` is already required on TMP
  context-match requests (`property-registry-catalog.md`), so part of "make it a
  protocol type" ships today. **Net-new:** a `$id`'d schema type for
  `property_rid`, the normative non-authoritative-surrogate language, and the
  `evidence`/`confidence` two-axis statement.
- **Registry-internal (not wire-visible):** `candidate_edges`, the `part_of`
  edge, and the anchor/hint identifier tiering are catalog-internal — no wire
  schema. They need migrations, not protocol-version bumps.
- **Governance, not schema:** the enum-evolution gate (§4) is a process doc in
  `docs/governance/property/`, not a schema artifact.
- **Deferred to a later major:** signed `signed_attestation` evidence value (§5)
  and full append-only Merkle-provability of the change-feed.

## Sequencing

1. This RFC + the [alignment framing](./property-definition-alignment.md).
2. Graduate the catalog data model (property_rid type, fact/rank/alias,
   `candidate_edges`, anchor/hint identifier tiering) — resolve #3/#4 here.
3. Ontology-evolution governance section in `docs/governance/property/`.
4. Signed cross-attestation envelope (reuse request-signing L1 / jwks).
5. TTL re-verify + lapse (shared with #5752 follow-up).

Related: `specs/registry-authorization-model.md` (the shipped `evidence`/`disputed`/
`seq_no` model and the deferred cross-attestation decision),
`specs/property-registry-catalog.md`, `specs/property-definition-alignment.md`
(the four-layer framing), `specs/registry-change-feed.md` (#5732),
`docs/governance/property/`, #5750 / #5752 (authority spine).
