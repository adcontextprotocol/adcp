# Split identity and trust: brand.json + trust.json

**Status**: Accepted (decisions 2026-09-30 and 2026-10-02). Ready for implementation, starting with PR 0 and PR 1 in the [plan](#plan). RFC [#7809](https://github.com/adcontextprotocol/adcp/issues/7809).

**Related**: [#6033](https://github.com/adcontextprotocol/adcp/issues/6033) (demand-side acts-for grants), [`capabilities-brand-url.md`](./capabilities-brand-url.md) (the `brand_json_url` bootstrap this supersedes)

**Draft schemas**: [`trust.json`](./brand-identity-trust-split/trust.json), [`trust-acknowledgements.json`](./brand-identity-trust-split/trust-acknowledgements.json), and [examples](./brand-identity-trust-split/examples/). Validate with `node specs/brand-identity-trust-split/validate.cjs`. These live under `specs/` on purpose, so none of this is published protocol surface until the implementation PRs below land.

**Decided**:
- A separate well-known trust record. brand.json becomes identity-only, with the trust fields removed in 4.0.
- The record is **`/.well-known/trust.json`**. It is protocol-neutral, with a generic core and per-protocol profiles; this document defines the AdCP profile.
- #6033 demand-side grants land in trust.json, not brand.json.
- **Acknowledge-by-reference** is the model for accepting grants: the grantee lists `{grantor, agent_url, via}` in its own trust.json, and terms live only in the grantor's document.
- **Stewardship and hosting.** AgenticAdvertising.org owns the trust.json core and the namespace rules; each protocol owns its profile. Schemas are published at **`https://trustjson.org/schemas/v1/`** and the spec's home is trustjson.org, served from this repository's pipeline. brand.json's schema moves to **brandjson.org** at AdCP 4.0, with `/schemas/v3/brand.json` kept as a permanent alias.
- **Tenant privacy:** opaque tenant paths for v1; templated agent entries only if vendors need them (security review first).
- **Grant by operator domain in adagents.json:** deferred. If adopted later, forbid it for mutating scopes and pinned keys.
- **Operator-side relationship signal:** keep the optional per-acknowledgement `delegation_type`, failing closed on mismatch.
- **Removal durability:** reuse adagents.json's revoked-publisher-domain retention (7-day hold); no second rule.
- **`exclusive_grants` default in 4.0:** decide after 3.x adoption data.

**In progress**: JournalList `trust.txt` outreach before IANA registration (owner: Brian O'Kelley).

## TL;DR

The rule is one question per file:

| File | Answers | Published by |
|---|---|---|
| `brand.json` | **Who am I?** Identity, owned properties, brand family | Every organization |
| `trust.json` *(new, protocol-neutral)* | **Which agents do I run, with which keys? Who may act for me? Whose grants do I accept?** | Anyone who runs agents or delegates authority |
| `adagents.json` | **Who may sell my inventory / use my data?** | Publishers and data providers (unchanged) |

Four invariants:

- **brand.json never carries keys or grants.**
- **A grant lives with the party making it.** This is #6033's own principle.
- **The party receiving a grant acknowledges it by reference and never restates its terms.** Consent stays two-sided, and nothing can drift.
- **The organization a trust record speaks for is the host that serves it**, never a value inside the document.

Nothing in the core is ad-specific. "Which agents does this organization run, with which keys, and who may act for it" is a question for any agent protocol. AdCP is the first profile, not the only one.

## Problem

`brand.json` is the only well-known document every AdCP organization hosts, so every feature that needed an org-scoped, domain-anchored home landed there:

- `authorized_operators` (#1011)
- `collections[].seller_agent_url` (#1642)
- generic `agents[]` (#1973)
- `ad_network` relationships (#2171)
- `jwks_uri` (#2316)
- `data_subject_contestation` (#2338)
- `brand_refs` (#4505)
- `identity_relying_parties` (#5387)

What's actually missing is an agent trust document; brand.json absorbed that role. The consequences:

- **Supply-path authorization is written twice, in two vocabularies.** `seller-setup.mdx` tells people to "keep both files aligned". The two sides have already drifted: brand.json's `property` description says matching applies to "delegated and network paths", but the `relationship` field says "non-owned", which includes `direct`.

  | | publisher `adagents.json` | operator `brand.json` |
  |---|---|---|
  | agent | `authorized_agents[].url` | `agents[].url` |
  | properties | `property_ids[]` | `properties[].identifier` |
  | relationship | `delegation_type` | `properties[].relationship` |
  | keys | `signing_keys[]` (inline) | `agents[].jwks_uri` (by reference) |

- **Keys have up to four declarations per agent:** brand.json `jwks_uri`, the default `/.well-known/jwks.json`, the adagents `signing_keys[]` pin, and capabilities `identity.key_origins`. The bootstrap field is named `identity.brand_json_url`.
- **A buyer's brand.json carries keys for agents other companies run.** Governance `iss` must be a governance-typed entry in the *buyer's* brand.json, so multi-tenant vendors' per-tenant `jwks_uri` gets copied into every customer's file.
- **Four different bootstraps** resolve "find agent A in brand.json": request signing, webhooks, governance JWS, and the `verify_brand_claim` response cross-check.
- **Brand-family trust vocabulary leaked into supply-path trust.** `verification/overview.mdx` applies `mutual_assertion` / `one_sided_brand` states, which no schema defines, to the seller↔publisher path.
- **Brand tooling and trust data share a file.** In AAO's own registry this let content edits reach trust fields, which PR #7822 fixed. Separate files make that separation structural.

The reference implementation barely enforces any of this. Nothing compares `relationship` with `delegation_type`. adagents `signing_keys` pins are indexed but never used to verify a signature. `authorized_operators` has no production reader. So it is cheap to change now.

## Why a separate file (alternatives considered)

| Alternative | Why not |
|---|---|
| Extend `adagents.json` | adagents.json is the grantor's file: publishers, plus data providers for `signals[]`. Governance vendors, agencies, buyers and SSPs have nothing to grant and don't publish one, and crawlers treat its presence as "this is a publisher". |
| Put the record on `get_adcp_capabilities` or an A2A agent card | Self-attested. `security.mdx` forbids an agent attesting its own keys, and a per-agent card can't hold org-level grants. |
| Keep one file with `identity` / `trust` sections | The key-resolution fetch has a 256 KiB body cap and a cache TTL bounded by JWKS revocation polling (`security.mdx` brand_json_url step 4). Rich identity data (`visual_guidelines`, assets) shouldn't live under either. Different teams own the two halves, and tooling can clobber one while editing the other. |
| Rename fields so both files match | Still stores the agreement twice. |
| OpenID Federation (`/.well-known/openid-federation`) | The closest general-purpose precedent: an organization-level document with keys, metadata and a trust hierarchy. But it is built on signed JWT entity statements and trust anchors, while the ad ecosystem runs on unsigned JSON served over TLS from well-known URLs (ads.txt, sellers.json). trust.json keeps that deployment model and leaves room for signed statements later. |

Prior art:
- **ads.txt / sellers.json.** Grantor and grantee each publish at a well-known URL.
- **ads.txt 1.1 `OWNERDOMAIN` / `MANAGERDOMAIN`.** Hosted delegation.
- **`did:web` (`/.well-known/did.json`).** A domain-anchored document of keys and service endpoints.
- **A2A `agent-card.json`.** Per-agent self-description, which complements an org-level trust record.
- **JournalList `trust.txt`.** Org affiliation declarations for news publishers. See [Governance and naming](#governance-and-naming).

## trust.json

Hosted at `https://{host}/.well-known/trust.json`. Two variants:

- **Authoritative Location Redirect.** A pointer for hosted records: a managed network, a platform, or AAO hosting. One hop, zero HTTP redirects.
- **Trust Record.** The top level is closed (`additionalProperties: false`); vendor data goes under `ext.{vendor}`. This keeps the file from becoming the next catch-all.

### Generic core

| Field | Purpose |
|---|---|
| `agents[]` | Agents this organization runs: `url`, namespaced `roles`, optional `protocols` (`mcp`, `a2a`), `jwks_uri`, `countries`, per-protocol `profiles` |
| `grants[]` | Authority this organization delegates: `grantee` domain, optional `agents[]` narrowing, namespaced `scopes`, `countries`, `valid_from` / `valid_until`, per-protocol `profiles`. Never carries keys |
| `exclusive_grants` | Opt-in to fail-closed: when true, `grants[]` is exhaustive for the scopes it names |
| `acknowledgements[]` / `acknowledgements_url` | Grants this organization accepts: `grantor`, `agent_url`, and `via`, which names where the grant is published. Terms stay in the grantor's document |
| `profiles` | Record-level per-protocol data |

**Namespaces.** Roles, scopes and grant sources are `<namespace>:<name>` tokens, and each protocol owns its namespace. Consumers MUST ignore namespaces they don't implement. `profiles` objects are keyed by the same namespaces. The bare scope `*` covers everything.

### AdCP profile

| AdCP concept | trust.json | Replaces |
|---|---|---|
| Agent types | `roles`: `adcp:brand`, `adcp:rights`, `adcp:measurement`, `adcp:governance`, `adcp:creative`, `adcp:sales`, `adcp:buying`, `adcp:signals` | brand.json `agents[].type` (`brand-agent-type` enum) |
| Rights-agent metadata | `agents[].profiles.adcp.{available_uses, right_types}` | brand.json `brand_agent_entry` rights fields |
| Demand-side grants (#6033) | `grants[]` with `scopes`: `adcp:media_buying`, `adcp:creative_generation`, `adcp:rights_clearance`, `adcp:governance`, `adcp:measurement`, `adcp:agent_operations`, `adcp:brand_identity` (new), `adcp:all`; brand scoping in `grants[].profiles.adcp.brands` | brand.json House Portfolio `authorized_operators[]` |
| Supply-path acknowledgement | `acknowledgements[]` with `via: "adcp:adagents"`; optional `profiles.adcp.delegation_type` | brand.json `properties[]` with `relationship` ≠ `owned` |
| Grant sources | `adcp:adagents` (publisher adagents.json `authorized_agents[]`), `adcp:trust` (another organization's trust.json `grants[]`) | — |
| TMP relying parties | `profiles.adcp.identity_relying_parties` | brand.json house/brand `identity_relying_parties` |
| Discovery pointer | `get_adcp_capabilities` `identity.trust_url` | `identity.brand_json_url` |

The schema enforces the AdCP vocabulary: any token in the `adcp:` namespace must be one AdCP defines. Other namespaces are open.

Examples:

- [direct publisher](./brand-identity-trust-split/examples/direct-publisher.json). No acknowledgement needed: first-party inventory is self-evident.
- [managed-network pointer](./brand-identity-trust-split/examples/managed-publisher-pointer.json)
- [network with sharded acknowledgements](./brand-identity-trust-split/examples/network.json), plus its [sub-document](./brand-identity-trust-split/examples/network-acknowledgements.json)
- [brand house](./brand-identity-trust-split/examples/brand-house.json). Grants only, no agents.
- [agency](./brand-identity-trust-split/examples/agency.json). Its own buying agent, plus a #6033 grant to an intermediary.
- [multi-tenant governance vendor](./brand-identity-trust-split/examples/governance-vendor.json). Opaque tenant paths.
- [multi-protocol organization](./brand-identity-trust-split/examples/multi-protocol-org.json). An AdCP brand agent alongside a non-ad agent in another namespace.

## Proposed normative rules

The generic rules belong to the trust.json spec. The AdCP-specific rules belong to the AdCP profile, in `security.mdx` and related docs.

### Agent resolution (generic; AdCP binds it to every signing surface)

In AdCP, request signing, webhook signing, governance JWS `iss`, rights attestations, `verify_brand_claim` / designated-task response signing, and TMP all cite this one algorithm. Given agent URL `A`:

1. **Fetch the agent's back-pointer.** In AdCP: fetch `A`'s `get_adcp_capabilities` from canonical `A`, with zero redirects and SSRF validation.
2. **Locate the trust record.**
   - The pointer MUST be exactly `https://{H}/.well-known/trust.json`. In AdCP it is `identity.trust_url`.
   - Fetch it with zero HTTP redirects, following at most one `authoritative_location` hop, also with zero redirects. The operator is `H`.
   - If the legacy `identity.brand_json_url` is also present, its host MUST equal `H`.
3. **Origin binding.** eTLD+1(`A`) MUST equal eTLD+1(`H`), using the pinned PSL snapshot.
   - There is no hosting-delegation fallback.
   - Cross-organization cases, such as a platform running an agent for a brand, go through a grant: the platform lists the agent in its own record, and the brand grants the platform.
4. **Match the agent.** Exactly one `agents[]` entry must canonically equal `A`. No match → `request_signature_agent_not_in_trust_record`. More than one → `…_ambiguous`.
5. **Find the keys.** Use the entry's `jwks_uri`. The verifier may default to `/.well-known/jwks.json` on `A`'s origin only when `A`'s host equals `H` and no other entry shares that origin. (AdCP: the `identity.key_origins` consistency check is unchanged.)
6. **Apply the publisher pin (AdCP, narrowing only).** For a sell-side signature about publisher P's inventory, accepted keys = P's adagents `signing_keys` pin ∩ the JWKS from step 5. A pin never adds keys and never applies outside P's inventory.
7. **Result.** The verified agent identity is canonical `A`; the operator is `H`.

**Every discovery path is bound both ways.** Any agent-URL → trust-record mapping MUST have confirmed that `A`'s back-pointer names that record. That includes prior onboarding, registry caches and crawler indexes. If several records list `A`, only the one `A` points to counts.

### No downgrade during AdCP 3.x

- When `identity.trust_url` is present, verifiers MUST ignore brand.json `agents[]`, `jwks_uri` and `authorized_operators` for that operator.
- When only `identity.brand_json_url` is present, verifiers MUST probe `https://{host}/.well-known/trust.json`:
  - **200:** use it, and ignore brand.json trust fields.
  - **404:** fall back to the legacy brand.json path. Negative-cache for at most 60 s.
  - **Any other failure:** fail closed.
- Once a verifier has seen a valid trust record for a host, it MUST NOT fall back for that host.
- Anyone emitting both files, such as AAO hosting, MUST generate them from one source.

### Acknowledgements: accept by reference (generic)

- **The grant** lives in the grantor's document, located via `via`, and is the **only** source of terms.
- **The acknowledgement** is `{grantor, agent_url, via}` in the grantee's record.
  - `agent_url` MUST be an `agents[]` entry in the same record, and that agent MUST point back to the record. An acknowledgement for an agent the organization doesn't run is invalid. This stops a third party borrowing another operator's grant.
  - An acknowledgement isn't needed when eTLD+1(grantor) = eTLD+1(`H`).
- **Relationship states:**

  | State | Meaning |
  |---|---|
  | `mutual` | Both the grant and the acknowledgement exist |
  | `grantor_only` | The grant exists; no acknowledgement |
  | `mismatch` | A profile assertion contradicts the grant (see below) |
  | *(none)* | An acknowledgement with no grant. It is not a relationship, and registries MUST NOT display it |

- **Bulk acknowledgements** go in `acknowledgements_url`, a same-host, shardable sub-document. It is fetched only by verifiers checking a relationship, never on the signature path.

**AdCP profile (`via: "adcp:adagents"`):**
- Resolve `https://{grantor}/.well-known/adagents.json`, following `authoritative_location` and managed-network rules.
- Require an `authorized_agents[]` entry whose canonical `url` equals `agent_url` and that reaches the grantor under the reachable-publisher rule. One acknowledgement covers every entry for that URL, whatever its `authorization_type`.
- Property scope, `delegation_type` and `signing_keys` come only from adagents.json. That answers the RFC's "who wins": the publisher, on terms.
- Optional `profiles.adcp.delegation_type` keeps the sellers.json-style cross-check buyers use as a fraud signal. When present it MUST equal the publisher's value, and a mismatch fails closed as `mismatch`.
- These states replace the undefined `mutual_assertion` / `one_sided_*` vocabulary in `verification/overview.mdx`.
- The publisher can widen or narrow scope on its own, while the relationship still needs both parties.

Compared with "both sides sign the same object", this needs no canonical serialization, no new signature scheme, and no re-signing every time the publisher edits its file.

### Grants (generic, with AdCP binding)

- **Chain limit.** Grants are non-transitive, and the maximum chain is grantor → grantee → the grantee's own agents. A grantee's own single-hop grant covers the #6033 intermediary case. A grantee MUST NOT extend a grant it received.
- **No keys in grants.** A grant names a grantee domain and optionally agent URLs; keys always come from the agent's own operator record.
- **Your own agents need no grant.** An organization's own `agents[]` act for it without one.
- **Freshness.**
  - Cache TTL ≤ the JWKS revocation polling ceiling (30 min); negative cache ≤ 60 s.
  - `valid_until` is enforced on every check.
- **Absence vs failure.** No grants, or `exclusive_grants` absent or false, means relying-party discretion. A **fetch failure is never equivalent to absence**: once a relying party has seen `exclusive_grants: true` for a host, it fails closed on failure.

**AdCP profile:**
- **Checking a claim.** Say `sync_accounts` names brand B and operator O, and the call comes from agent `A`:
  - B's house trust.json MUST contain an active grant covering O, the brand (`profiles.adcp.brands`), the country and the scope.
  - If the grant lists `agents[]`, `A` MUST be one of them. Otherwise `A` MUST resolve to O.
- **Re-verification.** Sellers re-verify at every `sync_accounts` and on mutating calls. `sync_accounts.operator` MUST match a grant, never a value the caller asserts.
- **Designating third-party agents.** Third-party governance, measurement, rights and brand agents are designated with a grant carrying `adcp:governance`, `adcp:measurement`, `adcp:rights_clearance` or `adcp:brand_identity`.
- **Demand-side acknowledgement is not required.** The brand's grant plus the agent's verified signature is sufficient.

### Hosting (generic)

- The organization is always the host serving `/.well-known/trust.json`, even when that file is a pointer.
- A hosted record MUST NOT be attributed to any domain other than the one serving the pointer.
- Hosts serving records on an organization's behalf MUST only serve records the organization controls. Community-edited or scraped data MUST NOT be served as a trust record.

## What stays in brand.json, what moves

| Stays in brand.json | Moves to trust.json (AdCP profile) |
|---|---|
| Identity: names, url, logos, colors, fonts, tone, tagline, industries, visual_guidelines, assets, voice, avatar, disclaimers, contact, privacy_policy_url | `agents[]` (all types), `house.agents`, `brands[].agents`, `jwks_uri` → `agents[]` with `adcp:*` roles |
| `properties[]` with `relationship: owned` (or absent). Identity resolution and attribution use these | `properties[]` with `direct` / `delegated` / `ad_network` → `acknowledgements[]` with `via: "adcp:adagents"` |
| `house_domain` / `brand_refs[]`: already reciprocal pointers over a bare edge, which is the pattern this RFC asks for | `authorized_operators[]` → `grants[]` |
| Redirect variants | `identity_relying_parties[]` → `profiles.adcp.identity_relying_parties` |
| `brand_agent` pointer as **discovery only**. Verifiers MUST NOT treat any brand.json agent pointer as authority | Deprecated `brand_agent` / `rights_agent` authority → the operator's own `agents[]`, or a grant with `adcp:brand_identity` / `adcp:rights_clearance` |

Out of scope for this RFC: `trademarks[].license_type` / `licensor_domain`, `data_subject_contestation`, `product_catalog.agentic_checkout`, `collections[].seller_agent_url`.

## Proposed deltas to existing AdCP schemas (implementation PRs)

- **`protocol/get-adcp-capabilities-response.json`:**
  - Add `identity.trust_url` (HTTPS; MUST be `https://{host}/.well-known/trust.json`).
  - Move the "MUST be present when the agent declares any signing posture" rule and the 4.0 "schema-required" commitment from `brand_json_url` to `trust_url`.
  - `brand_json_url` becomes a deprecated alias whose host MUST match.
  - Change `agent_url_match: "byte_equal"` to canonical.
- **`static/schemas/source/trust/v1/`:** `trust.json` and `trust-acknowledgements.json`, built by this repository's pipeline on their own version track and served at `https://trustjson.org/schemas/v1/`. See [Governance](#governance-and-naming).
- **`brand.json`:**
  - Mark `agents`, `house.agents`, `brand_agent`, `rights_agent`, `authorized_operators`, `identity_relying_parties`, and non-owned `properties[].relationship` values as deprecated, pointing to trust.json.
  - No removals in 3.x.
- **Error codes:** add `request_signature_agent_not_in_trust_record`. Keep the brand.json codes for the legacy path until 4.0.

## Before / after by persona

| Persona | Today | Proposed |
|---|---|---|
| Direct publisher | brand.json (identity + agent + keys + owned properties) + adagents.json | brand.json (identity + owned properties) + trust.json (agent + keys) + adagents.json. **Nothing to hand-sync**: no self-acknowledgement |
| Publisher on a managed network | adagents.json pointer, plus a brand.json with "leave these fields out" rules | adagents.json pointer, an optional identity-only brand.json, an optional trust.json pointer |
| SSP / network | brand.json with one `properties[]` entry per represented property, each `relationship` matched against the publisher's `delegation_type` | trust.json `agents[]` + `acknowledgements_url` with one `{grantor, agent_url, via}` per publisher. Nothing restated |
| Agency / trading desk | brand.json `agents[]`; no way to grant an intermediary (#6033) | trust.json: its own `agents[]` + `grants[]` for intermediaries |
| Brand house | brand.json identity + `authorized_operators` + governance agent entries with vendor `jwks_uri` | brand.json identity + trust.json grants only (no keys) |
| Governance vendor | Keys copied into every customer's brand.json | One trust.json listing its tenants, with opaque tenant paths |
| Standalone advertiser, no agents | brand.json | brand.json (unchanged) |
| Organization running non-ad agents | — | trust.json with its own namespace's roles and scopes; no brand.json requirement |

## Governance and naming

- **Standalone spec.** trust.json is published by AgenticAdvertising.org at trustjson.org as its own small spec, versioned independently of AdCP. Schemas live at `https://trustjson.org/schemas/v1/`. AdCP 3.x references a trust.json version and defines the `adcp` profile. AdCP never blocks on adoption outside advertising.
- **Namespaces.** Each protocol owns its namespace and the profile schema under `profiles.{namespace}`. The trust.json spec holds only the generic core and the namespace rules.
- **IANA.** `trust.json` isn't in the well-known URI registry. Register it (RFC 8615), and register `brand.json` and `adagents.json` too, since neither is registered today.
- **JournalList `trust.txt`.** `trust.txt` is registered (provisional) and is hosted by news publishers, who are part of AdCP's audience. It declares organization affiliations. A `trust.json` beside it will read as its JSON sibling. **Action (in progress, Brian O'Kelley):** contact JournalList before registering, to align or at least clearly differentiate. Their affiliation vocabulary may map onto brand-family and grant concepts.

## Migration and versioning

**AdCP 3.x (minor, additive):**
- The trust.json v1 schemas and `identity.trust_url` are introduced.
- Resolvers implement the precedence and no-downgrade rules.
- brand.json trust fields are deprecated but still read on the legacy path.
- #6033 lands only in trust.json.

**Honest cost:** `brand_json_url` stays MUST-when-signing through 3.x, and 3.x verifiers follow it to brand.json `agents[]`. So **signing operators dual-publish for the whole 3.x line**. AAO hosting emits both files from one source.

**AdCP 4.0 (major):**
- Remove the trust fields from brand.json.
- Remove `brand_json_url`.
- `trust_url` becomes schema-required when signing.

**Compliance:**
- `universal/webhook-emission` (`agents_jwks_uri_missing`), `test-kits/hosted-grader` and `test-kits/signed-responses-runner` need a dual-source mode in 3.x.
- The `brand-response-signing` test vectors need trust.json variants.
- `distributed_brand_resolution` / `single_side_trust_extension` are unaffected, since `brand_refs` stays.

## Plan

| PR | Scope | Changeset |
|---|---|---|
| **0** | Spec consistency fixes, independent of the split. See below | patch |
| **1** | One agent-resolution algorithm in `security.mdx`, still backed by brand.json, cited by every surface: canonical URL matching everywhere, the pin as a narrowing intersection, one bootstrap | patch / minor |
| **2** | trust.json v1 schemas into `static/schemas/source/trust/v1/`, `identity.trust_url`, resolver precedence + no-downgrade, storyboard dual-source, seller-setup rewrite | minor |
| **3** | Acknowledgements (`via: adcp:adagents`) supply verification + relationship states; deprecate non-owned `relationship`; registry support | minor |
| **4** | #6033 grants in trust.json (`authorized_operators` → `grants`, `exclusive_grants`, `adcp:brand_identity`) | minor |
| **5** | AdCP 4.0 removal | major |
| — | IANA registration (trust.json, brand.json, adagents.json); JournalList outreach | — |

**PR 0: inconsistencies found in the audit.**

- Agent-URL matching is byte-for-byte for webhooks and governance `iss`, and capabilities advertises `agent_url_match: "byte_equal"`, but request signing canonicalizes.
- The adagents `signing_keys` pin scope has three different answers.
- `verification/overview.mdx` and `seller-setup.mdx` describe RFC 9421-signed responses, which `security.mdx` forbids for synchronous responses.
- Signing step 3 reads `authorized_operators` from documents where the schema forbids it.
- `trust.mdx` cites a nonexistent `parent_house` field.
- `security.mdx` refers to an undefined "adagents-style agent registry".
- It is ambiguous whether `direct` requires a matching `delegation_type`.
- `key-concepts.mdx` and the rights walkthrough still teach the deprecated `rights_agent` / `brand_agent`.
- The capabilities schema `spec` link is stale.
- `accounts-and-agents.mdx` calls operator verification both "a signal, not a gate" and "MUST pass".

## Answers to the RFC's open questions

1. **Where should an agent's identity and keys live?** In the operating organization's `trust.json`. "Agents carry their own keys" is honored by the default `/.well-known/jwks.json` on the agent origin and by per-agent `jwks_uri`. The listing must come from the operator's domain, though, because an agent must not self-attest.
2. **Does brand-family structure stay in brand.json?** Yes. `house_domain` ↔ `brand_refs[]` is two reciprocal pointers over a bare edge; nothing can drift.
3. **When the two sides disagree, who wins?** The grantor is the sole source of terms. The only possible disagreement is an optional profile assertion (AdCP `delegation_type`), and it fails closed as `mismatch`.
4. **Transition window and dual-emit?** Dual-emit is allowed in 3.x and effectively required for signing operators. Removal is in 4.0.

## Review history

**v1 → v2 (protocol, security and product expert review):**
- eTLD+1 binding kept, and the operator is the serving host.
- Default JWKS constrained.
- No-downgrade rules added.
- The publisher pin narrows only.
- One demand-side grant array.
- Acknowledgements bound to the record's own agents and moved off the key path.
- Optional operator-side `delegation_type` kept.
- Hosting redirect added.
- brand.json agent pointers are discovery-only.

**v3 → v4 (decisions, 2026-10-02):**
- Acknowledge-by-reference adopted.
- AgenticAdvertising.org owns trust.json; schemas at trustjson.org, brand.json to brandjson.org at 4.0.
- Tenant privacy, grant-by-operator-domain, per-acknowledgement `delegation_type`, removal durability, and the `exclusive_grants` default resolved as listed under **Decided**.

**v2 → v3 (decisions, 2026-09-30):**
- Split accepted.
- Renamed to `trust.json` and made protocol-neutral: a generic core (`agents`, `grants`, `acknowledgements`) plus namespaced roles, scopes and grant sources, with per-protocol `profiles`.
- AdCP became the first profile.
- `authorized_operators` → `grants`, and `sells_for` → `acknowledgements` with `via`.

## Open questions

None blocking. See **Decided** and **In progress** at the top.
