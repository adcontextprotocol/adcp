# How the Community Aligns on Property Definitions

**Status**: Draft (WG framing)

## The reframe

A healthy decentralized registry does **not** align by getting everyone to agree
on one definition. It **converges on evidence**, with a domain-rooted spine and
reversible mistakes. Every durable decentralized-naming system works this way —
DNS, Certificate Transparency, Wikidata, ads.txt/sellers.json, schema.org. The
ones that tried to mint a single canonical truth by committee either failed or
re-centralized into a registrar.

So the community's job is not to ratify definitions. It is to **contribute
attributable claims into a graph where the domain owner always wins and mistakes
are never destructive**. AdCP already made this bet: the property catalog is a
*fact graph*, not a declaration store (`specs/property-registry-catalog.md` —
"facts, not declarations"; "the rid is forever"; "aliases, not deletions").

## The trap: four problems wearing one coat

"Align on property definitions" is **four problems with four different trust
roots**. Collapsing them is the recurring failure mode — it is how you end up
reflexively wanting to "just build a property registry," the GS1 move that
ad-tech rejected for inventory.

| Layer | Question | Trust root | Precedent |
|---|---|---|---|
| **1. Ontology** | What *types / identifiers* exist? | **WG rough consensus**, versioned, additive. Central curation is correct *here only*. | schema.org / IAB taxonomy |
| **2. Referential identity** | Is *this* the same thing as *that*? | **Non-authoritative fact graph** — emergent, ranked, reversible. | Wikidata (rank + reversible merge) |
| **3. Authority / provenance** | Who may *assert* the canonical record? | **Domain control at the origin** (adagents.json / brand.json over TLS). Never a registrar. | ads.txt / sellers.json + DNS |
| **4. Boundary / granularity** | Is ESPN one property or four? | **The owner declares** in their own file; never registry-adjudicated, never algorithm-derived. | npm (ownership-convention + dispute) |

AdCP has **layer 3 right and layer 1 mostly right**; layers 2 and 4 are the open
work, and they deliberately live in the (still-Draft) catalog, *beside* the
origin, never above it. That separation is correct — do not promote referential
identity or boundary into the authoritative wire (adagents.json / brand.json).

## The two invariants that make an open write surface safe

1. **Origin always wins; mistakes alias, never delete.** A contributed claim may
   corroborate or dispute a domain-controlled fact, but can **never** override
   it. Concretely, two axes carry this (`specs/registry-authorization-model.md`):
   authorization rows carry an `evidence` value — `adagents_json` (the
   publisher's own origin file under HTTPS, authoritative-by-definition) vs the
   non-authoritative `agent_claim` / `community` — and the snapshot endpoint
   defaults to `adagents_json`-only so a consumer never treats an unverified
   claim as authority. Identifier *linking* uses a separate `confidence` scale
   (`authoritative` / `strong` / `medium` / `weak`). The invariant is
   schema-enforced (`evidence` CHECK + snapshot default), not caller discipline.
2. **You can unilaterally DISAVOW, never unilaterally CLAIM.** Removing your
   origin file or marking `not_ours` is zero-burden, immediate, authoritative.
   Asserting authority over inventory you do not domain-control is structurally
   impossible.

## Where the shipped work sits on this spine

The two registry fixes are **two points on the layer-3 authority spine**, not
separate features:

- **#5750 (gap #2)** — the **property-save** community write surface cannot mint
  authorization: `authorized_agents` is forced to `[]` on `POST /properties/save`;
  the origin adagents.json is the sole authorization source. (Invariant 1.) The
  remaining caller-supplied writers of the same column (Addie `save_property`,
  admin save, mcp-tools) carry the same gap and are a tracked follow-up (#5751).
- **#5752 (gap #1)** — the authority model is **claim → origin-verify → bind**,
  not a write-time gate. Anyone may stage a non-authoritative row; ownership is
  bound only when the publisher places a claim-token pointer at their own origin
  and verification confirms it. Binding is token-driven (never caller-driven),
  so a squatter cannot bind a domain they do not control, and an existing owner
  is never overwritten. (Invariant 2.)

Read together: the registry never mints authority and never gatekeeps writes —
it accepts attributable claims that **converge to origin-verified facts**.

## What AAO is (and is NOT)

To hold the line against the "just build a property registry" reflex, AAO's role
is fenced by construction:

- **NOT a registrar.** AAO holds no minting authority. `workos_organization_id`
  is set only by a verified-origin claim bind; `authorized_agents` is forced `[]`
  on community writes; authoritative records are refused edits (409).
- **A neutral index** of origin-verified facts.
- **Registrar-of-last-resort only** for the long tail with no self-hosted file —
  those rows are community-tier, non-authoritative for *authorization*, and
  instantly superseded the moment the publisher deploys their own origin file.
  (This **amends** catalog Design Principle #6, which today reads "the registry
  IS the authoritative declaration" for fileless properties: the registry may be
  the *identity* record-of-last-resort for such a property, but it is **not**
  authoritative for sales authorization — `authorized_agents` stays `[]` — and
  the bridge is that "authoritative" there means identity/listing, never
  authority-to-sell. The graduation RFC restates Principle #6 accordingly.)
- **A dispute desk**, not a truth oracle — it records, ranks, and routes
  conflicts; it does not adjudicate boundary or sameness.

## Detect-not-prevent

You cannot *prevent* a false claim in a decentralized system; you make it
**undeniable and fast to catch** (Certificate Transparency's lesson). The
registry change-feed (`specs/registry-change-feed.md`, #5732) is most of the way
there — it already emits `publisher.adagents_changed` / `authorization.granted` /
`authorization.revoked` over SSE. The high-leverage, low-cost next step is a
**publisher-domain-scoped subscription filter** so an owner can watch for any
claim naming their domain they did not make; defer full append-only
Merkle-provability to a later major. (Revocation *propagation* is already handled
by `seq_no` rotation-on-tombstone — `specs/registry-authorization-model.md`.)

## What this framing asks of the WG

1. Treat the four layers as separate, with separate trust roots. Resist
   collapsing them.
2. Govern the **ontology** (property_type / identifier-types enums) as an
   additive, versioned vocabulary — see the catalog-graduation RFC for the
   enum-evolution process (the one genuine layer-1 gap today).
3. Graduate the **catalog** from Draft to normative-but-non-authoritative so
   layers 2 and 4 have a real home — see `specs/property-catalog-graduation.md`.
4. Keep **authority** rooted in domain control. Never a registrar.

Related: `specs/registry-authorization-model.md` (the shipped authorization data
model — `evidence` enum, `disputed` layer, `seq_no` revocation, the deferred
cross-publisher / signed-attestation decision), `specs/property-registry-catalog.md`
(the fact graph), `specs/registry-change-feed.md` (freshness/notifications, #5732),
`docs/governance/property/` (adagents.json / brand.json trust model),
#5750 and #5752 (the authority-spine implementations).
