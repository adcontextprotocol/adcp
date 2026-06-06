# TMP Verified Identity Attestation — Design Proposal

**Status**: proposed (draft for review).
**Target surface**: TMP Identity Match (`identity_match_request`), experimental.
**Relates to**: [`docs/trusted-match/context-and-identity.mdx`](../docs/trusted-match/context-and-identity.mdx), [`docs/trusted-match/data-protection-roles.mdx`](../docs/trusted-match/data-protection-roles.mdx), [`docs/trusted-match/specification.mdx`](../docs/trusted-match/specification.mdx).

This proposal adds a way for a publisher to forward a **verifiable** proof about a user — proof of unique personhood, proof of age, or any similar claim — alongside the opaque identity tokens already carried in Identity Match, so the buyer can *verify* the claim cryptographically instead of *trusting the publisher's assertion*. It uses World ID (idkit, v4) as the worked example, but the mechanism is issuer-agnostic.

## Problem

Today an Identity Match entry is `{ user_token, uid_type }` — an opaque token the buyer resolves against its own graph. If a publisher checks something about the user out-of-band (the user signed in with World ID, passed an age gate, proved they are a unique human) and wants the buyer to act on it, the publisher has only one channel: **assert it**. "This token is a verified unique human, over 18." The buyer must trust the publisher's word, and the publisher can fabricate it.

This is the wrong trust posture for two demand cases that are becoming load-bearing:

1. **Sybil-resistant frequency capping / proof-of-personhood.** The value of a personhood signal is precisely that it can't be forged or churned. An *asserted* personhood signal has none of that value — a publisher can claim every impression is a unique human.
2. **Age-gated demand (alcohol, gambling, dating, regulated categories).** Age assurance is increasingly a legal requirement, not a targeting nicety. A buyer (and the regulator behind it) needs assurance the gate was actually satisfied, not that the publisher says so.

The core insight: a zero-knowledge proof from an identity issuer is the issuer speaking *directly* to the buyer. The publisher is **transport, not attester**. A forwarded proof is a first-party cryptographic statement from the user's credential — not hearsay — and the publisher cannot mint a valid one. We want a wire mechanism that lets the publisher relay that proof rather than re-assert its conclusion.

## Framing: the relying-party boundary is the linkability boundary

World ID (and any comparable issuer) derives its per-user identifier — the **nullifier** — from the user, the **relying party (`rp_id`)**, and an **action**. In World ID v4 the nullifier is scoped to the `rp_id`: two relying parties cannot stitch a user together, even if operated by the same entity. The action is a scope knob *within* a relying party.

That single fact bounds the entire design space. **Whoever is the relying party determines the linkability scope of the identifier.** Two topologies fall out, and this proposal supports both:

| Topology | Relying party | Nullifier scope | Use |
|---|---|---|---|
| **Publisher-as-RP** | The publisher | Per-publisher pseudonym; unlinkable across publishers by construction | Within-publisher Sybil-resistant fcap; age gate; verifiable but pub-scoped |
| **Network-as-RP** | A buyer / network (e.g. an interchange) | Stable cross-publisher unique-human ID *within that network's namespace* | Cross-pub reach & frequency against provably-unique humans; credentialed eligibility |

A publisher-scoped nullifier **can never be promoted to network scope** — the audience (`rp_id`) is fixed when the proof is minted, and re-targeting it would be exactly the cross-RP stitching the issuer exists to prevent. So enabling a network requires a *separate proof minted for the network's `rp_id`*. This proposal therefore defines two transport mechanisms, one per topology.

## Non-goals

- **Not a new identity graph.** TMP does not resolve identifiers; it carries them. This proposal carries a *proof about* an identifier, nothing more.
- **Not mandatory.** Absent an attestation, Identity Match behaves exactly as today.
- **Not a cross-publisher ID by default.** Mechanism A preserves per-publisher scoping. Cross-pub linkage (Mechanism B) is opt-in, user-consented, and addressed to a named audience.
- **No raw attributes on the wire.** Age is carried as a `claim` (`age_over_18`), never as a date of birth. Resolution to eligibility (below) keeps even the claim out of broad circulation.
- **Not World-ID-specific.** `issuer` / `scheme` are open; an mDL (ISO 18013-5) age proof or any VC-style issuer fits the same shape.

## Mechanism A — Verifiable attestation (in-band, publisher-as-RP)

The publisher is the relying party. It runs the issuer's verification flow, obtains a proof bound to its own `rp_id`, and forwards the **proof bundle** (not a conclusion) on the matching identity entry. The receiving buyer re-verifies it.

### Schema sketch — `attestation` on an `identities[]` entry

```jsonc
{
  "user_token": "<nullifier_hash>",      // the identifier the proof attests
  "uid_type": "other",                   // see "uid_type choice" below
  "attestation": {
    "issuer": "world_id",                // attestation authority
    "scheme": "world_id_v4",             // proof scheme + version (verifier selection)
    "rp_id": "<publisher rp_id>",        // audience the proof is bound to
    "action": "<action string>",         // scope within the rp_id
    "claims": ["unique_human", "age_over_18"],
    "verification_level": "orb",         // credential strength (orb | device | document)
    "signal_binding": "<keccak256(signal)>",  // context the proof commits to
    "proof": { /* scheme-specific verifiable material: proof, merkle_root, ... */ },
    "expires_at": "2026-06-07T00:00:00Z" // validity window
  }
}
```

### What the buyer MUST do before trusting the claims

1. **Verify the proof** against the issuer's public verifier/root for `scheme` (e.g. on-chain verification, or a stateless verifier library). A valid proof establishes that a real credential holder produced it — the publisher cannot forge this.
2. **Check `signal_binding`** against the context the buyer expects the proof to commit to (a nonce the buyer issued, the `request_id`, or a freshness window). Verification of the proof alone does **not** prevent replay — without binding, a publisher can verify one real human and replay that proof across all its impressions. The binding + the buyer tracking nullifier reuse is what closes this.
3. **Check `rp_id` provenance** — that this `rp_id` legitimately belongs to the entity claiming the traffic, so a forwarded proof bound to `rp_id=X` cannot be replayed under a different owner. See [Provenance: rp_id scope and where the binding lives](#provenance-rp_id-scope-and-where-the-binding-lives).
4. Only then treat `claims` as established.

Residual risk after these checks: **collusion** (a publisher and a willing real human minting genuine proofs for fabricated ad context). Signal-binding to buyer-verifiable context shrinks it; removing the publisher from the loop entirely (Mechanism B / network-as-RP) eliminates it. This is a spectrum, not a binary — documented as such.

### uid_type choice

The attested identifier (a nullifier) behaves like a `publisher_first_party` token for *matching* — opaque, per-publisher, no cross-site linkage. But tagging it `publisher_first_party` discards the one thing that makes it valuable: the buyer can't tell a Sybil-resistant nullifier from an ordinary churn-able first-party cookie.

Decision: add a dedicated **`world_id_nullifier`** value to `uid-type.json`. This is consistent with how the enum already works — its members are vendor-specific identifier types (`uid2`, `id5`, `rampid`, `pairid`), each with distinct resolution and verification semantics. A World ID nullifier likewise has distinct semantics (Sybil-resistant, `rp_id`-scoped, unlinkable, verified via the attestation), so a vendor-specific value is the consistent choice, not an exception. The cost is touching the enum's other consumers (audience sync, event logging), which is additive. The name is `world_id_nullifier`, not `world_id`: World ID issues more than identifiers (age and other credentials), and it is the *nullifier* specifically that is the identifier here.

The enum value names the token *type*; it does not replace the `attestation` object. The proof material, `rp_id`, `verification_level`, and `claims` (e.g. `age_over_18`) still ride the attestation. A buyer that sees `world_id_nullifier` with no verifiable attestation MUST treat it as an unverified opaque token — the enum value asserts nothing about personhood or age on its own.

### Provenance: rp_id scope and where the binding lives

Verifying the proof establishes that *a* real credential holder produced it. It does not establish *whose* relying party it was produced for — a malicious relay could forward a genuine proof bound to some other party's `rp_id`. Closing this needs a published, discoverable binding from `rp_id` to its owner that the buyer checks during step 3 above.

**What `rp_id` is scoped to.** In World ID v4 the nullifier's unlinkability boundary *is* the `rp_id` — two `rp_id`s cannot correlate a user. World ID does not mandate whether an `rp_id` maps to an entity or a single property; it is a relying party an entity *registers*, and the entity chooses the granularity. That choice is not cosmetic — it sets the cross-property linkability of the resulting pseudonym:

- **One `rp_id` for the whole entity** → a user is one stable pseudonym across *all* of that entity's properties. The entity is effectively running a within-brand identity graph — the same "more durable, cuts both ways" data-protection weight as Mechanism B, bounded to one company.
- **One `rp_id` per property** → per-property pseudonyms, unlinkable even across the same entity's properties.

So the scope decision is also a privacy-scope decision: larger `rp_id` scope = more linkage = more data-protection weight.

**Where the binding lives.** An `rp_id` is *entity-controlled* — a relying party an entity registers with the issuer, mapped to whatever properties the entity chooses — so the authoritative "entity E owns `rp_id` X" declaration belongs in **`brand.json`** ("what I own"), the entity's canonical ownership/discovery surface. This is the fact the buyer verifies the proof's `rp_id` against. Note what does *not* need publishing: the cryptographic verification anchor (World's Merkle root / on-chain verifier) is global and public. Only the ownership binding is per-entity. The descriptor is issuer-keyed, so it generalizes past World ID:

```jsonc
// in the entity's brand.json
"identity_relying_parties": [
  {
    "issuer": "world_id",
    "scheme": "world_id_v4",
    "rp_id": "<entity rp_id>",
    "scope": "entity"          // "entity" (links across the entity's properties) | "property"
  }
]
```

`adagents.json` keeps its existing job — *who may sell this property's inventory* (`authorized_agents[]`). The `rp_id` is not a seller; it is the publisher's own identity-proof anchor, which is why it does not belong in the seller-authorization list. When an entity runs **per-property** `rp_id`s, a property's `adagents.json` MAY name which of the entity's declared `rp_id`s applies to it, but the ownership root stays in `brand.json`.

**Hardening the self-assertion.** `brand.json` is self-published, like `adagents.json`. To close the gap where one entity claims another's `rp_id`, the binding should be bidirectional: the issuer's relying-party metadata (e.g. the World ID Developer Portal) declaring the `rp_id`'s owning domain, cross-checked against that domain's `brand.json`. Tracked as an open question.

For the **network-as-RP** case (Mechanism B), the `rp_id` is the *network's* entity, so it lives in the network's own `brand.json` — the publisher is not the relying party and does not assert it.

### Why this is allowed to cross the strict identity boundary

`identity-match-request.json` sets `additionalProperties: false` and deliberately omits `ext`/`context` "to prevent data leakage across the identity privacy boundary." That boundary exists to keep **page context** out of the identity path — not to keep identity-proof out. An attestation carries proof *about the identity*, which is squarely on the identity side of the boundary and introduces no context leakage. Adding `attestation` is a deliberate, contract-bearing widening of the strict schema, justified on exactly the boundary's own terms.

The attestation rides the **request** (publisher → buyer), is verified, and informs eligibility. It does **not** round-trip through the `tmpx` exposure token and is not bound by the `maxItems: 3` / ~120-byte TMPX plaintext budget. Receivers MUST bound attestation size and count to prevent DoS amplification (same class of concern as oversized `package_ids[]`).

## Mechanism B — Sealed cross-RP credential (pass-through, network-as-RP)

The publisher is the *surface*, not the relying party. In the same user ceremony, the user mints a second proof scoped to a **network's** `rp_id` (e.g. an interchange). That proof is HPKE-sealed to the network's key, so the publisher relays it but **cannot read it** — the network-scoped nullifier is opaque to the publisher by construction, and verifiable only by the named audience.

### Schema sketch — top-level `sealed_credentials[]`

```jsonc
{
  "type": "identity_match_request",
  "request_id": "id-9b2c",
  "seller_agent_url": "https://publisher.example",
  "identities": [ /* ... pub-scoped tokens, optionally with Mechanism A attestation ... */ ],
  "sealed_credentials": [
    {
      "audience_kid": "k_interchange_1",                       // identifies recipient HPKE key
      "payload": "k_interchange_1.<base64url_nopad(ciphertext)>" // HPKE-sealed attestation, opaque to publisher
    }
  ]
}
```

`payload` reuses the **exact `tmpx` envelope** — `kid.base64url_nopad(ciphertext)`, unpadded base64url per RFC 4648 §5 — so there is one HPKE convention across TMP. There is already precedent in the spec for a publisher carrying an encrypted blob it cannot open destined for another party (`tmpx`); this is the request-side mirror of it. Inside the sealed payload is a full Mechanism-A attestation object whose `rp_id` is the network's and whose nullifier is network-scoped. The publisher MUST treat `payload` as opaque pass-through.

### Properties

- **Cross-publisher, Sybil-resistant identity within the network's namespace** — the network's fcap cap-state can key on the network nullifier, giving cross-pub frequency control immune to cookie churn and bot inflation.
- **Opt-out is structural.** The network ID only exists for users who consented to prove to the network in the ceremony; the publisher can simply not request or not forward the sealed credential. There is no silent cross-pub tracking.
- **Publisher is a pure conduit** for the network claim — it does not (cannot) process it. That is a cleaner processor story for the publisher with respect to the network's data than if it were re-asserting it.

## Integration models (hosting topology)

The relying-party choice from [Provenance](#provenance-rp_id-scope-and-where-the-binding-lives) is also a *deployment* choice: it decides who runs the secret-bearing server. The `rp_id` is a public "publishable" identifier; the **`signing_key`** (which World ID v4 requires to sign every proof request) and the proof-verification step are secrets that MUST live server-side, on whoever is the relying party. Two models follow, with the same shape as a payments integration — publishable key in the client, secret key on the provider, hosted components for low-friction integrators.

**Hosted (network-as-RP) — the v1 default.** The network (e.g. an interchange) operates the `rp_id`, holds the `signing_key`, and runs request-signing and proof-verification centrally for every publisher. The publisher embeds a client widget/SDK pointed at the network's hosted endpoints and stands up **no server**. This is the Stripe-Checkout analog and the deployment of Mechanism B — the low-friction path that lets a corporate website integrate with a script tag. Its cost equals its convenience: the network holds a cross-publisher unique-human graph (see [Data protection](#data-protection)). The friction lever and the centralization lever are the same lever.

**Self-hosted (publisher-as-RP).** The publisher operates its own `rp_id` and `signing_key` and signs/verifies on its own infrastructure — in practice a serverless function from a template (sign request, verify proof, `signing_key` as an env secret), not a standing service. This is the deployment of Mechanism A: per-publisher privacy scoping, no cross-publisher graph, more control, more setup.

| | Hosted (network-as-RP) | Self-hosted (publisher-as-RP) |
|---|---|---|
| Runs `signing_key` + verify | Network | Publisher (serverless template) |
| Publisher server | None | One edge function |
| Identifier scope | Network-wide unique human | Per-publisher pseudonym |
| Cross-pub graph | Network holds it | None |
| Mechanism | B | A |
| Friction | Lowest | Low, self-serve |

The two are not exclusive: a network MAY offer the hosted path as default while letting sophisticated publishers self-host their own `rp_id` and still route through the network. The integration model is the `rp_id`-scope decision wearing a deployment hat.

## Age as eligibility, not as a wire attribute

Even with a verifiable age attestation, the cleanest integration keeps the *attribute* out of broad circulation: the party holding the credential resolves it into `eligible_package_ids`. An alcohol package lands in the eligible set only for nullifiers carrying a verified `age_over_18` claim; the buyer never needs to expose the attribute downstream, and nothing sensitive crosses further than the verifying party. The attestation is what makes that gate *trustable*; resolution-to-eligibility is what keeps it *private*. The two compose.

Age requirements are jurisdiction- and category-dependent, but the wire must stay simple. The trap is putting the jurisdiction table on the wire; the fix is to split two concerns.

### Age threshold claims (closed enum)

What the proof attests is a **threshold claim** ("over N"), carried in the attestation `claims` as a small, closed, AdCP-standard enum: `age_over_13`, `age_over_16`, `age_over_18`, `age_over_21`. (`age_over_20` — Japan/Thailand/Korea — was considered and deferred; further thresholds such as `age_over_25` can be added later, additively, if a real legal threshold needs them.) Members are derived from actual legal thresholds, not invented.

The set is **closed and AdCP-owned, not network-proprietary**, because: a buyer must share semantics to verify and act on `age_over_18`; ZK age proofs are practical only for a handful of standard thresholds, and proving an unusual age (e.g. "over 19") is itself identifying; and a closed set keeps the eligibility check to "verified claim ≥ required threshold." A network MAY choose which thresholds it resolves against, but MUST use these claim names — inventing its own breaks attestation portability across buyers. (`age_over_*` is distinct from the unrelated `world_id` value in the `age-verification-method` enum, which names a *method*, not a threshold.)

### Jurisdiction resolution via the Policy Registry

The jurisdiction → threshold rule ("alcohol means 21 in the US, 18 in the UK, 20 in Japan") is category-specific, changes with law, and is a compliance/liability decision — so it is **policy, not a protocol constant**. It lives in the [AdCP Policy Registry](/docs/governance/policy-registry), reusing the existing `required_policies` / [`check_governance`](/docs/governance/campaign/tasks/check_governance) machinery:

1. A package declares **category intent** by requiring an age policy (e.g. a `legal-drinking-age` policy) in `required_policies` — not by enumerating thresholds.
2. The policy definition holds the jurisdiction → threshold table.
3. At eligibility time the verifying party resolves `(policy, geo) → required threshold claim` — `(legal-drinking-age, US) → age_over_21`, `(legal-drinking-age, GB) → age_over_18` — checks the verified attestation carries a claim ≥ that threshold, and includes/excludes the package in `eligible_package_ids`.

This keeps the wire to a single threshold claim, puts the jurisdiction table where it can change without a protocol revision, and lets a buyer express "make my alcohol campaign compliant everywhere" instead of encoding law per region. The age policies and their jurisdiction → threshold tables are maintained centrally in the **AAO Policy Registry** — one shared source of truth, not per-network tables — so every network resolves against the same compliance data. The verifying party owns the runtime assertion that it resolved and enforced them correctly; in the network-as-RP model that is the network (already the controller).

**Expression.** Prefer the policy reference (declarative; resolves per geo) as the way a campaign requests an age gate, with an explicit minimum threshold claim as an override for a buyer that wants a fixed floor regardless of geo.

**Geo granularity.** Sub-country rules (US state-level alcohol/cannabis/gambling) cannot be resolved on the Identity Match path, whose geo is country-coarse by design and stripped before forwarding. Sub-country resolution happens where finer geo is available — network-side at eligibility time, which the hosted topology provides; the protocol does not carry region on the identity path.

## Data protection

Mechanism A does not move the existing role map ([`data-protection-roles.mdx`](../docs/trusted-match/data-protection-roles.mdx)): publisher remains controller, buyer remains a conditional processor, and the issuer ceremony is **user-initiated selective disclosure** — the user consents to revealing the specific claim, which strengthens the consent story. The `consent` object still rides along; a persistent pseudonymous nullifier is still personal data regardless of its Sybil resistance.

Mechanism B is the model where the buyer/network becomes a controller of a cross-publisher unique-human graph — precisely the "cross-publisher exposure accumulation" already flagged as the headline data-protection exposure. Proof-of-personhood makes that graph *more durable*, which cuts both ways. The network needs its own legal basis; this is a distinct processing purpose from the publisher's serve decision. The sealed-credential design at least keeps the publisher out of the network's processing.

## Relationship to OAuth Identity Assertion Authorization Grant (XAA)

The IETF OAuth working group's [Identity Assertion Authorization Grant](https://datatracker.ietf.org/doc/html/draft-ietf-oauth-identity-assertion-authz-grant) (Cross-App Access, "XAA") solves an adjacent problem: a client in one trust domain presents a signed identity assertion (an **ID-JAG** JWT, obtained from its IdP via RFC 8693 Token Exchange) to a Resource Authorization Server in another domain via the RFC 7523 JWT-bearer grant, and receives an access token scoped to that domain. It is the standard shape for "carry a verifiable identity assertion across a trust-domain boundary and have the receiver exchange it for scoped authorization."

**Where it fits — the control plane of Mechanism B.** Establishing a network-scoped credential from a user's proof *is* a cross-domain identity-assertion exchange, and XAA is the recognized pattern for it. If a network (e.g. an interchange) mints its network-scoped credential from an inbound proof, doing so as an RFC 8693 token exchange is standards-aligned: subject token in → audience-bound token out. The draft's strict audience rule — `aud` MUST equal the receiving AS's issuer identifier — is the same binding as our `rp_id` / `audience_kid`; mirror its normative phrasing.

**Where it does not fit.** Three mismatches keep XAA out of Mechanism A and out of the per-impression data plane:

1. **Opposite identity model.** XAA federates a *named, correlatable principal* (`sub` + `iss` + `tenant`) and explicitly does not address anonymity or unlinkability — it *preserves* cross-domain correlation by design. World ID is the inverse: an anonymous, `rp_id`-scoped, unlinkable pseudonym with selective attribute disclosure. A nullifier cannot occupy an ID-JAG `sub` without breaking the privacy property. So at the attribute-attestation layer (Mechanism A), XAA is the wrong tool.
2. **Authorization, not attestation.** XAA yields an OAuth access token (delegated API access). TMP needs a *claim the buyer factors into eligibility*. Minting access tokens for ad decisions would over-rotate TMP into an auth framework it does not need on the hot path.
3. **Interactive.** XAA is two token-endpoint round trips with policy evaluation. TMP's per-impression data plane is a single router fan-out under a tight latency budget with temporal decorrelation — no room for OAuth token-endpoint calls per impression.

The division is therefore **control plane vs. data plane**: XAA / RFC 8693 is how you *establish* a network-scoped credential (once, out of band); `sealed_credentials[]` / `tmpx` is how you *carry* its output (per impression).

**The trust fork it surfaces.** XAA lives entirely in the signed-assertion-JWT world — trust roots in whoever signs the assertion (verified via JWKS / federation). Mechanism A deliberately forwards the **raw ZK proof** instead, so the receiver runs the cryptography itself and there is *no trusted attester in the loop* — the whole point of "verifiable, not asserted." The moment a World ID proof is wrapped in someone's signed JWT, trust roots in that signer again. This is a deliberate divergence, not a gap: raw-ZK buys trustlessness at the cost of the JOSE/OAuth toolchain; signed-assertion-JWT buys the toolchain at the cost of a trusted signer. Mechanism A chooses trustlessness; an XAA-based Mechanism B establishment step may reasonably choose the toolchain, since the network is already a trusted controller in that topology.

**Adjacent, not addressed here.** XAA is also emerging as the pattern for agent-to-agent cross-domain authorization (agents calling APIs on behalf of a user across domains). That is relevant to how TMP *agents* authenticate across domains (buyer agent ↔ router ↔ network) — a separate layer from the personhood/age attestation in this proposal, tracked separately.

## Conformance (proposed)

An implementation claiming verified-attestation support MUST:

- Verify the proof for every `scheme` it accepts; reject (treat as absent) any attestation that fails verification, signal-binding, `rp_id` provenance, or `expires_at`.
- Never treat an unverified or unverifiable attestation as a trusted claim — silent downgrade to "no attestation," never to "asserted true."
- Bound attestation size/count and sealed-credential size/count.
- For Mechanism B, decrypt only `sealed_credentials[]` whose `audience_kid` it holds the key for; ignore the rest.

## Open questions

- **`scheme` registry.** A small registry of verifier schemes (`world_id_v4`, `mdl_18013_5`, …) vs. free-form `issuer`/`scheme` strings with out-of-band verifier selection. Recommendation: free-form strings for v1 (issuer-agnostic, defers registry governance) with a documented recommended set. The same `issuer`/`scheme` pair appears in the `brand.json` `identity_relying_parties` descriptor, so the decision spans both surfaces.
- **`identity_relying_parties` in `brand.json`** — confirm the field shape and the `entity` vs `property` scope marker, and the bidirectional issuer-metadata cross-check that hardens the self-assertion. Coordinate with the brand.json schema owners.
- **Router handling of `sealed_credentials[]`** — **decided (all three).** The router filters identities per provider and re-signs each forward over the filtered identities + `request_id`; a top-level `sealed_credentials[]` is covered by neither that signature nor the dedup cache key, so: (a) forward by `audience_kid` to the owning provider (not broadcast); (b) fold `sealed_credentials` into the per-provider re-signature canonical bytes so an injected/swapped blob breaks the signature; (c) add a `sealed_credentials_hash` to the dedup cache key so a network-credential-driven eligibility change invalidates a cached response. Must land in the same bundle as the field.
- **Mechanism B consent composition.** How the network's own legal basis composes with the request-level `consent` object: the network-as-RP graph is a distinct processing purpose, and the user's in-ceremony selective disclosure is the consent event for the network claim. State this normatively — it is the consent basis for persisting the cross-publisher nullifier graph.
- **Multi-audience ceremony ergonomics.** Whether idkit-class SDKs can mint pub-scoped + network-scoped proofs in one user interaction, or whether it is two ceremonies — affects UX, not the wire contract.
- **Attestation in the response path?** Whether a buyer should ever return an attestation (e.g. "eligibility granted on a verified-human basis") — likely no; eligibility is intentionally reasonless. Listed for completeness.
- **Replay window policy.** Recommended default freshness window for `signal_binding` and whether the buyer or the spec sets it.

## Summary

| | Asserted (today) | Mechanism A | Mechanism B |
|---|---|---|---|
| Trust root | Publisher's word | Issuer crypto; publisher is a checkable relay | Issuer crypto; publisher removed from the identity trust path |
| Linkability | Per-pub token | Per-pub nullifier | Per-network nullifier (cross-pub) |
| Publisher can forge? | Yes | No | No (cannot even read) |
| Cross-pub fcap | No | No | Yes |
| Age gate trustable? | No | Yes | Yes |

The durable protocol contribution is the move from **asserted** to **verifiable** identity and age claims, expressed as an issuer-agnostic attestation that rides the existing Identity Match request and (for cross-RP cases) the existing HPKE envelope.
