# Split identity and trust: brand.json + adcp-trust.json

**Status**: Direction accepted: split trust out of brand.json (2026-09-30). Remaining decisions below. (RFC [#7809](https://github.com/adcontextprotocol/adcp/issues/7809))

**Related**: [#6033](https://github.com/adcontextprotocol/adcp/issues/6033) (demand-side acts-for grants), [`capabilities-brand-url.md`](./capabilities-brand-url.md) (the `brand_json_url` bootstrap this supersedes)

**Draft schemas**: [`brand-identity-trust-split/adcp-trust.json`](./brand-identity-trust-split/adcp-trust.json), [`adcp-trust-sells-for.json`](./brand-identity-trust-split/adcp-trust-sells-for.json), [examples](./brand-identity-trust-split/examples/). These live under `specs/` on purpose, so nothing here is published protocol surface until the implementation PRs below land.

**Decided**:
- Introduce a separate well-known trust record; brand.json becomes identity-only (removal in 4.0).
- #6033 demand-side grants land in the new file, not in brand.json.

**Decisions still needed**:
1. The file's name (working name `adcp-trust.json`).
2. Acknowledge-by-reference for the supply path.

## TL;DR

The rule is one question per file:

| File | Answers | Published by |
|---|---|---|
| `brand.json` | **Who am I?** Identity, owned properties, brand family | Every organization |
| `adcp-trust.json` *(new)* | **What agents do I run and with which keys? Who may act for me? Whose grants do I accept?** | Anyone who runs agents or grants demand-side authority |
| `adagents.json` | **Who may sell my inventory / use my data?** | Publishers and data providers (unchanged) |

Four invariants:

- **brand.json never carries keys or grants.**
- **A grant lives with the party making it.** This is #6033's own principle.
- **The party receiving a grant acknowledges it by reference and never restates its terms.** Two-sided consent stays; drift can't happen.
- **The organization a trust record speaks for is the host that serves it**, never a value inside the document.

## Problem

`brand.json` is the only well-known document every AdCP organization hosts. Every feature that needed an org-scoped, domain-anchored home landed there:

- `authorized_operators` (#1011)
- `collections[].seller_agent_url` (#1642)
- generic `agents[]` (#1973)
- `ad_network` relationships (#2171)
- `jwks_uri` (#2316)
- `data_subject_contestation` (#2338)
- `brand_refs` (#4505)
- `identity_relying_parties` (#5387)

The actual gap is that AdCP has no operator/agent trust document. Brand.json absorbed that role. The consequences:

- **Supply-path authorization is written twice, in two vocabularies.**

  | | publisher `adagents.json` | operator `brand.json` |
  |---|---|---|
  | agent | `authorized_agents[].url` | `agents[].url` |
  | properties | `property_ids[]` | `properties[].identifier` |
  | relationship | `delegation_type` | `properties[].relationship` |
  | keys | `signing_keys[]` (inline) | `agents[].jwks_uri` (by reference) |

  `seller-setup.mdx` tells people to "keep both files aligned". The two sides have already drifted: brand.json's `property` description says matching applies to "delegated and network paths", but the `relationship` field says "non-owned", which includes `direct`.
- **Keys have up to four declarations per agent.** They are brand.json `jwks_uri`, the default `/.well-known/jwks.json`, the adagents `signing_keys[]` pin, and capabilities `identity.key_origins`. The bootstrap field itself is named `identity.brand_json_url`.
- **A buyer's brand.json has to carry keys for agents other companies run.** Governance `iss` must be a governance-typed entry in the *buyer's* brand.json, and multi-tenant vendors must get per-tenant `jwks_uri` copied into every customer's file.
- **Four different bootstraps** resolve "find agent A in brand.json": request signing, webhooks, governance JWS, and the `verify_brand_claim` response cross-check.
- **Brand-family trust vocabulary leaked into supply-path trust.** `verification/overview.mdx` applies `mutual_assertion` / `one_sided_brand` states, which no schema defines, to the seller↔publisher path.
- **Brand tooling and trust data share a file.** Anyone editing logos is one save away from trust fields.

Enforcement is thin in the reference implementation. Nothing compares `relationship` with `delegation_type`, adagents `signing_keys` pins are indexed but never used to verify a signature, and `authorized_operators` has no production reader. That makes this cheap to change now.

## Why a separate file (alternatives considered)

| Alternative | Why not |
|---|---|
| Extend `adagents.json` | adagents.json is the grantor's file: publishers, and data providers for `signals[]`. Governance vendors, agencies, buyers and SSPs have nothing to grant and don't publish one, and crawlers treat its presence as "this is a publisher". Extending it repeats the brand.json mistake from the other direction. |
| Put the record on `get_adcp_capabilities` or an A2A agent card | Self-attested. `security.mdx` forbids an agent attesting its own keys, and a per-agent card can't hold org-level grants. |
| Keep one file with `identity` / `trust` sections | The key-resolution fetch has a 256 KiB body cap and a cache TTL bounded by JWKS revocation polling (`security.mdx`, brand_json_url step 4). Rich identity data (`visual_guidelines`, assets) shouldn't live under either. Different teams own the two halves, and the tooling hazard remains. |
| Rename fields so both files match | Removes the vocabulary mismatch but still stores the agreement twice. |

Prior art: ads.txt / sellers.json (grantor and grantee each publish at a well-known URL). ads.txt 1.1 `OWNERDOMAIN` / `MANAGERDOMAIN` (hosted delegation). `did:web` `/.well-known/did.json` (a domain-anchored document of verification keys and service endpoints).

## `adcp-trust.json`

Hosted at `https://{host}/.well-known/adcp-trust.json`. There are two variants:

- **Authoritative Location Redirect.** A pointer for hosted records, e.g. a managed network or AAO hosting. One hop, zero HTTP redirects.
- **Trust Record.** The top level is closed (`additionalProperties: false`, vendor data goes under `ext.{vendor}`) so this file can't become the next catch-all.

| Field | Replaces | Purpose |
|---|---|---|
| `agents[]` | brand.json `agents[]`, `house.agents`, `brands[].agents`, `jwks_uri` | Agents this organization runs, with keys |
| `authorized_operators[]` | brand.json House Portfolio `authorized_operators[]` | The **only** demand-side grant array. Adds optional `agents[]` (#6033, triage Option B) and a `brand_identity` scope |
| `exclusive_grants` | — | Explicit opt-in to fail-closed demand-side authorization (#6033 absence semantics) |
| `sells_for[]` / `sells_for_url` | brand.json `properties[]` with `relationship` ≠ `owned` | Acknowledgements of supply grants received; terms stay in the publisher's adagents.json |
| `identity_relying_parties[]` | brand.json house/brand `identity_relying_parties` | TMP attestation provenance (experimental, no implementations yet) |

Examples:

- [direct publisher](./brand-identity-trust-split/examples/direct-publisher.json). No `sells_for`: first-party inventory is self-evident.
- [managed-network pointer](./brand-identity-trust-split/examples/managed-publisher-pointer.json)
- [network with sharded acknowledgements](./brand-identity-trust-split/examples/network.json) and its [sub-document](./brand-identity-trust-split/examples/network-sells-for.json)
- [brand house](./brand-identity-trust-split/examples/brand-house.json). Grants only, no agents.
- [agency](./brand-identity-trust-split/examples/agency.json). Its own buying agent, plus a #6033 grant to an intermediary.
- [multi-tenant governance vendor](./brand-identity-trust-split/examples/governance-vendor.json). Opaque tenant paths.

## Proposed normative rules

### Agent resolution: one algorithm for every signing surface

Request signing, webhook signing, governance JWS `iss`, rights attestations, `verify_brand_claim` / designated-task response signing, and TMP all cite this one algorithm. Given agent URL `A`:

1. **Fetch capabilities.** Fetch `A`'s `get_adcp_capabilities` from the canonical `A`, with zero redirects and SSRF validation.
2. **Locate the trust record.**
   - If `identity.adcp_trust_url` is present, it MUST be exactly `https://{H}/.well-known/adcp-trust.json`. Fetch it with zero HTTP redirects, following at most one `authoritative_location` hop, also with zero redirects. The operator is `H`.
   - If `identity.brand_json_url` is also present, its host MUST equal `H`.
3. **Origin binding.** eTLD+1(`A`) MUST equal eTLD+1(`H`), using the pinned PSL snapshot as today.
   - There is no `authorized_operators` hosting fallback.
   - Cross-organization cases (a platform running an agent for a brand) go through a grant: the platform lists the agent in *its own* record, and the brand grants the platform.
4. **Match the agent.** Exactly one `agents[]` entry must canonically equal `A`. No match → `request_signature_agent_not_in_trust_record`. Several matches → `…_ambiguous`.
5. **Find the keys.** Use the entry's `jwks_uri`. Only when `A`'s host equals `H` and no other entry shares that origin may the verifier default to `/.well-known/jwks.json` on `A`'s origin. The `identity.key_origins` consistency check is unchanged.
6. **Apply the publisher pin (narrowing only).** For a sell-side signature about publisher P's inventory, accepted keys = P's `signing_keys` pin ∩ the JWKS from step 5. A pin never adds keys and never applies outside P's inventory.
7. **Result.** The verified Agent identity is canonical `A`; the operator is `H`.

**Every discovery path is bound both ways.** Any agent-URL → trust-record mapping, including prior onboarding, registry caches and crawler indexes, MUST have confirmed that `A`'s capabilities names that record. If several records list `A`, only the one `A` points to counts. Otherwise a crawler that indexes records by agent URL becomes a key-injection path.

### No downgrade during 3.x

- When `identity.adcp_trust_url` is present, verifiers MUST ignore brand.json `agents[]`, `jwks_uri` and `authorized_operators` for that operator.
- When only `identity.brand_json_url` is present, verifiers MUST probe `https://{host}/.well-known/adcp-trust.json`:
  - **200:** use it, and ignore brand.json trust fields.
  - **404:** fall back to the legacy brand.json path. Negative-cache for at most 60 s.
  - **Any other failure:** fail closed.
- Once a verifier has seen a valid trust record for a host, it MUST NOT fall back to brand.json for that host.
- Anyone emitting both files (e.g. AAO hosting) MUST generate them from one source.

### Supply path: acknowledge by reference

- **The grant** is P's `adagents.json` `authorized_agents[]` entry.
  - Resolve it from `https://{P}/.well-known/adagents.json`, following `authoritative_location` / managed-network rules.
  - The entry must have canonical `url` = `A` and must reach P under the existing reachable-publisher rule.
  - It is the **only** source of property scope, `delegation_type` and `signing_keys`. That answers the RFC's "who wins": the publisher, on terms.
- **The acknowledgement** is `sells_for[]: {publisher_domain: P, agent_url: A}` in `H`'s record.
  - `A` MUST be an `agents[]` entry in the same record and MUST point back to `H`. An acknowledgement for an agent the organization doesn't run is invalid. This stops a third party borrowing another operator's grant.
  - One acknowledgement covers every entry for `A` in P's file, whatever the `authorization_type`.
  - It is not required when eTLD+1(P) = eTLD+1(`H`): first-party inventory is self-evident.
- **Optional `delegation_type` on the acknowledgement** keeps the sellers.json-style cross-check buyers use as a fraud signal. When present it MUST equal the publisher's value. A mismatch fails closed as state `mismatch`; neither side silently wins.
- **Relationship states:**

  | State | Meaning |
  |---|---|
  | `mutual` | Both the grant and the acknowledgement exist |
  | `publisher_only` | Grant exists; no acknowledgement |
  | `mismatch` | The acknowledgement's `delegation_type` differs from the publisher's |
  | *(none)* | Acknowledgement with no grant. It is not a relationship, and registries MUST NOT display it |

  These replace the undefined `mutual_assertion` / `one_sided_*` vocabulary in `verification/overview.mdx`.
- **The publisher can widen or narrow scope on its own**, while the relationship still needs both parties. Today, adding a property also needs an edit to the operator's brand.json.
- **Bulk acknowledgements go in `sells_for_url`**, a same-host, shardable sub-document. It is fetched only by supply-path verifiers and never on the signature path.

Compared with the RFC's "both sides sign the same object", this needs no canonical serialization, no new signature scheme, and no re-signing each time the publisher edits its file.

### Demand side: grants by the granting party

- **Checking a claim.** Say `sync_accounts` names brand B and operator O, and the call comes from agent `A`:
  - B's house record MUST contain an active `authorized_operators[]` entry covering O, the brand, the country and the scope.
  - If the entry has `agents[]`, `A` MUST be listed. Otherwise `A` MUST resolve to O through agent resolution.
- **Chain limit.** Delegation is non-transitive, and the maximum chain is house → operator → the operator's own agents or its own single-hop grant (the #6033 intermediary case, in O's own record). A grantee MUST NOT extend a grant it received.
- **Grants never carry keys.** A grant names an operator domain and optionally agent URLs. Keys always come from the agent's own operator record. That is how governance vendor keys leave buyers' files.
- **Designating third-party agents.** Third-party governance, measurement, rights and brand agents are designated with an `authorized_operators[]` entry carrying the matching scope (`governance`, `measurement`, `rights_clearance`, `brand_identity`). An organization's own `agents[]` act for it without a grant.
- **Freshness.**
  - Cache TTL ≤ the JWKS revocation polling ceiling (30 min); negative cache ≤ 60 s.
  - `valid_until` is enforced on every check.
  - Sellers MUST re-verify at every `sync_accounts` and on mutating calls.
  - `sync_accounts.operator` MUST match a grant, never a value the caller asserts.
- **Absence vs failure.** No grant block (or `exclusive_grants` absent or false) is seller discretion during 3.x. A **fetch failure is never equivalent to absence**. Once a seller has observed `exclusive_grants: true` for a host, it fails closed on failure.
- **Demand-side acknowledgement is not required.** The brand's grant plus the agent's verified signature is sufficient.

### Hosting

- The organization is always the host serving `/.well-known/adcp-trust.json`, even when that file is a pointer.
- A hosted record MUST NOT be attributed to any domain other than the one serving the pointer.
- Hosts serving records on an organization's behalf MUST only serve records the organization controls. Community-edited or enriched data MUST NOT be served as a trust record.

## What stays in brand.json, what moves

| Stays in brand.json | Moves to adcp-trust.json |
|---|---|
| Identity: names, url, logos, colors, fonts, tone, tagline, industries, visual_guidelines, assets, voice, avatar, disclaimers, contact, privacy_policy_url | `agents[]` (all types), `house.agents`, `brands[].agents`, `jwks_uri` |
| `properties[]` with `relationship: owned` (or absent). Identity resolution and attribution use these | `properties[]` with `direct` / `delegated` / `ad_network` → `sells_for[]` |
| `house_domain` / `brand_refs[]`: already reciprocal pointers over a bare edge, which is the pattern this RFC asks for | `authorized_operators[]` |
| Redirect variants | `identity_relying_parties[]` |
| `brand_agent` pointer as **discovery only**. Verifiers MUST NOT treat any brand.json agent pointer as authority | Deprecated `brand_agent` / `rights_agent` authority → the operator's own `agents[]`, or a grant with `brand_identity` / `rights_clearance` |

Out of scope for this RFC, noted for later: `trademarks[].license_type` / `licensor_domain`, `data_subject_contestation`, `product_catalog.agentic_checkout`, `collections[].seller_agent_url`.

## Proposed deltas to existing schemas (implementation PRs)

- **`protocol/get-adcp-capabilities-response.json`:**
  - Add `identity.adcp_trust_url` (HTTPS; MUST be `https://{host}/.well-known/adcp-trust.json`).
  - Move the "MUST be present when the agent declares any signing posture" rule and the 4.0 "schema-required" commitment from `brand_json_url` to `adcp_trust_url`.
  - `brand_json_url` becomes a deprecated alias whose host MUST match.
  - Fix `agent_url_match: "byte_equal"` → canonical.
- **`core/agent-entry.json` (new):** extracted from brand.json `brand_agent_entry`. brand.json `agents[]` and adcp-trust.json `agents[]` both reference it. `id` becomes optional in the new document, because the canonical URL is the identity.
- **`brand.json`:**
  - Mark `agents`, `house.agents`, `brand_agent`, `rights_agent`, `authorized_operators`, `identity_relying_parties`, and `properties[].relationship` values other than `owned` as deprecated, pointing to adcp-trust.json.
  - No removals in 3.x.
- **`authorized_operator`:** add optional `agents[]` and the `brand_identity` scope. `brands` becomes optional (absent = every brand the grantor owns) so non-house grantors (agencies) can issue grants.
- **Error codes:** add `request_signature_agent_not_in_trust_record`. Keep the brand.json codes for the legacy path until 4.0.

## Before / after by persona

| Persona | Today | Proposed |
|---|---|---|
| Direct publisher | brand.json (identity + agent + keys + owned properties) + adagents.json | brand.json (identity + owned properties) + adcp-trust.json (agent + keys) + adagents.json. **Nothing to keep in sync by hand**: no self-acknowledgement |
| Publisher on a managed network | adagents.json pointer, plus brand.json with "leave these fields out" rules | adagents.json pointer, optional identity-only brand.json, optional adcp-trust.json pointer |
| SSP / network | brand.json with one `properties[]` entry per represented property, each `relationship` matched against the publisher's `delegation_type` | adcp-trust.json `agents[]` + `sells_for_url` with one `{publisher_domain, agent_url}` per publisher. Nothing restated |
| Agency / trading desk | brand.json `agents[]`; no way to grant an intermediary (#6033) | adcp-trust.json: own `agents[]` + `authorized_operators[]` for intermediaries |
| Brand house | brand.json identity + `authorized_operators` + governance agent entries with vendor `jwks_uri` | brand.json identity + adcp-trust.json grants only (no keys) |
| Governance vendor | Keys copied into every customer's brand.json | One adcp-trust.json listing its tenants, with opaque tenant paths |
| Standalone advertiser, no agents | brand.json | brand.json (unchanged) |

Direct publishers go from two files to three. In exchange, every persona stops hand-syncing fields across files.

## Migration and versioning

**3.x (minor, additive):**
- The adcp-trust.json schema and `identity.adcp_trust_url` are introduced.
- Resolvers implement the precedence and no-downgrade rules above.
- brand.json trust fields are deprecated but still read on the legacy path.
- #6033 lands only in adcp-trust.json, so brand.json gains no new trust fields.

**Honest cost:** `brand_json_url` stays MUST-when-signing through 3.x, and 3.x verifiers follow it to brand.json `agents[]`. So **signing operators dual-publish for the whole 3.x line**. AAO hosting emits both files from one source.

**4.0 (major):**
- Remove the trust fields from brand.json.
- Remove `brand_json_url`.
- `adcp_trust_url` becomes schema-required when signing.

**Compliance:**
- `universal/webhook-emission` (`agents_jwks_uri_missing`), `test-kits/hosted-grader` and `test-kits/signed-responses-runner` need a dual-source mode in 3.x.
- The `brand-response-signing` test vectors need trust-record variants.
- `distributed_brand_resolution` / `single_side_trust_extension` are unaffected (`brand_refs` stays).

## Plan

| PR | Scope | Changeset |
|---|---|---|
| **0** | Spec consistency fixes, independent of the split. See below | patch |
| **1** | One agent-resolution algorithm in `security.mdx`, still backed by brand.json. Every surface cites it: canonical URL matching everywhere, pin = narrowing intersection, one bootstrap. This is where the resolution rules above get written down, so PR 2 becomes a pointer swap | patch / minor |
| **2** | `adcp-trust.json` + `adcp-trust-sells-for.json` into `static/schemas/source`; `identity.adcp_trust_url`; `core/agent-entry.json`; resolver precedence + no-downgrade; storyboard dual-source; seller-setup rewrite | minor |
| **3** | `sells_for` supply verification + relationship states; deprecate non-owned `relationship`; registry support | minor |
| **4** | #6033 grants in adcp-trust.json (`authorized_operators` move, `agents[]`, `exclusive_grants`, `brand_identity`) | minor |
| **5** | 4.0 removal | major |

**PR 0: inconsistencies found in the audit.**

- Agent-URL matching is byte-for-byte for webhooks and governance `iss`, and capabilities advertises `agent_url_match: "byte_equal"`, but request signing canonicalizes.
- The adagents `signing_keys` pin scope has three answers: "any signature", "sell-side webhook delivery only", and "signed agent responses".
- `verification/overview.mdx` and `seller-setup.mdx` describe RFC 9421-signed responses, which `security.mdx` forbids for synchronous responses.
- Signing step 3 reads `authorized_operators` from documents where the schema forbids it, and ignores `brands` / `scopes` / validity.
- `trust.mdx` cites a nonexistent `parent_house` field.
- `security.mdx` refers to an undefined "adagents-style agent registry" for buyer keys.
- It is ambiguous whether `direct` requires a matching `delegation_type`.
- `key-concepts.mdx` and the rights walkthrough still teach the deprecated `rights_agent` / `brand_agent`.
- The capabilities schema `spec` link is stale.
- `accounts-and-agents.mdx` calls operator verification both "a signal, not a gate" and "MUST pass".

Separately, and not protocol work: AAO hosting and brand tooling should stop accepting or serving trust fields on community-edited brand records, and the brand builder should merge rather than replace hosted documents.

## Answers to the RFC's open questions

1. **Where should an agent's identity and keys live?** In the operating organization's `adcp-trust.json`, not in `adagents.json` (see alternatives). "Agents carry their own keys" is honored in two ways: the default `/.well-known/jwks.json` on the agent origin, and per-agent `jwks_uri`. But the listing must come from the operator's domain, because an agent must not self-attest.
2. **Does brand-family structure stay in brand.json?** Yes. `house_domain` ↔ `brand_refs[]` is already two reciprocal pointers over a bare edge, with nothing to drift.
3. **When the two sides disagree, who wins?** There is nothing to disagree about except `delegation_type`, and only if the operator chooses to assert it. The publisher is the sole source of terms. A `delegation_type` mismatch fails closed as `mismatch`.
4. **Transition window and dual-emit?** Dual-emit is allowed in 3.x and effectively required for signing operators, because `brand_json_url` remains MUST-when-signing. Removal is in 4.0.

## Expert review (v1 → v2)

Protocol, security and product reviews of the first draft changed:

- **Name:** `operator.json` → working name `adcp-trust.json`. "Operator" already means the seller (x-entity-types), the buy-side agency (`sync_accounts`), and the agent runner (`security.mdx`). A brand house publishing "operator.json" full of `authorized_operators` reads backwards.
- **Origin binding:** eTLD+1 binding **kept**, not replaced by reciprocal pointers. The agent's back-pointer is written by whoever controls the agent host, so it disambiguates but doesn't authenticate. The binding added a second rule: the operator is the serving host, never a document field.
- **Default JWKS:** constrained so recycled platform subdomains can't become key sources.
- **Downgrade:** no-downgrade rules added for the 3.x dual-source period.
- **Publisher pin:** now narrows only (intersection) and is scoped to the publisher's own inventory, so a publisher can't add keys to another operator's agent.
- **Demand-side grants:** collapsed to one array (`authorized_operators` + `agents[]`). v1 had two, recreating the overlap the #6033 triage warned about. Grants never carry keys, and the non-transitivity and freshness rules are normative.
- **Acknowledgements:** `represents[]` → `sells_for[]`, moved off the key-resolution path (`sells_for_url`), and bound to the record's own agents to prevent laundering another operator's grant. Self-evident for first-party inventory.
- **Operator-side `delegation_type`:** kept as an optional assertion that fails closed on mismatch, to preserve the ads.txt/sellers.json cross-check buyers use against mislabeling.
- **Hosting:** authoritative-location redirect variant added.
- **brand.json agent pointers:** now explicitly discovery-only.

## Open questions

1. **Name.**
   - Candidates: `adcp-trust.json`, `operator.json`, `agent-authority.json`.
   - Check the IANA well-known URI registry (RFC 8615) for collisions.
   - Consider whether to register brand.json / adagents.json / the new name while we're at it.
2. **Tenant privacy for multi-tenant vendors.** Is an opaque tenant path enough, or do we need prefix/templated agent entries or per-tenant subdomain records? Templates need their own security review.
3. **Grant by operator domain in adagents.json** ("any agent Northwind lists"), as in ads.txt. It cuts publisher churn when operators rotate endpoints. It also widens blast radius and conflicts with per-agent pins. Deferred; if adopted, forbid it for mutating scopes and pinned keys.
4. **Operator-side relationship signal.** Is the optional per-entry `delegation_type` right, or is a single operator-level `seller_role` (publisher / sales house / network / SSP) enough for buyers' supply-path checks?
5. **Removal durability.** How long does a removed `sells_for` entry or revoked grant stay remembered? Align with adagents.json `revoked_publisher_domains` retention.
6. **`exclusive_grants` default in 4.0.** Should demand-side authorization become fail-closed by default?
