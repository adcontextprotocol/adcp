# Agent identity and buyer self-onboarding (3.3)

**Status**: Proposed. Maintainer-agreed design, for decision at the first WG working session ([decision brief on #7878](https://github.com/adcontextprotocol/adcp/issues/7878#issuecomment-6099382406)). Tracking issue: [#8118](https://github.com/adcontextprotocol/adcp/issues/8118).

**Related**: [#7878](https://github.com/adcontextprotocol/adcp/issues/7878) / [#7894](https://github.com/adcontextprotocol/adcp/pull/7894) (Web Bot Auth profile), [#7817](https://github.com/adcontextprotocol/adcp/issues/7817) (`adcp-agent-url`), [#7814](https://github.com/adcontextprotocol/adcp/issues/7814) (unknown signers), [`brand-identity-trust-split.md`](./brand-identity-trust-split.md) (trust.json, RFC [#7809](https://github.com/adcontextprotocol/adcp/issues/7809)), [#7942](https://github.com/adcontextprotocol/adcp/pull/7942) and [#6105](https://github.com/adcontextprotocol/adcp/issues/6105) (client-only signers), [#6033](https://github.com/adcontextprotocol/adcp/issues/6033) (demand-side grants), [#8113](https://github.com/adcontextprotocol/adcp/issues/8113) / [#8114](https://github.com/adcontextprotocol/adcp/issues/8114) (onboarding posture), [#7015](https://github.com/adcontextprotocol/adcp/issues/7015) (principal layer).

**Supersedes**, for Web Bot Auth identities, these parts of `brand-identity-trust-split.md`:
- the `identity.trust_url` back-pointer and "Every discovery path is bound both ways" (§Agent resolution);
- the acknowledgement "point back" rule (§Acknowledgements);
- the per-host no-downgrade probe (§No downgrade during AdCP 3.x), which R4 replaces.

It also supersedes the client-only bootstrap in #7942 and option B (`adcp-agent-url`) in #7817.

**Scope of 3.3**: the WBA profile covers signed **HTTP requests and webhooks**. JWS artifacts (governance context `iss`, designated-task response signing, rights attestations) stay on the 3.2 chain in 3.3. They move in 3.4, together with R3b and a provenance contract for governance keys, because a retained directory response proves key possession, not publication at a point in time (#7878 gates 3 and 4).

**Not in scope**: TMP, whose match-time signatures use publisher keys from the property registry, as `security.mdx` §Agent resolution already says.

New names in this document are **proposed**: the `Signature-Agent` profile in AdCP, `request_signature_agent_not_in_trust_record`, `signing_profiles`, `key_thumbprints`, `agent_onboarding`, `relationship`, and the new `principal.changed` reasons. The trust.json roles and scopes used here are already defined in `static/schemas/source/trust/v1/trust.json`.

## TL;DR

A buyer agent publishes two files and then onboards itself with any AdCP seller. It does not serve `get_adcp_capabilities` and receives no seller-issued credential. The signature is the credential.

| File | Where | Says |
|---|---|---|
| Key directory | `https://{agent origin}/.well-known/http-message-signatures-directory` | This origin's signing keys, one purpose each (Web Bot Auth). The response is signed per key with `created` and `expires` (WBA Appendix B.1), so it is regenerated on a schedule; it is not a write-once file. |
| Trust record | `https://{registrable domain}/.well-known/trust.json` | This origin is my agent, with these roles; these organizations may act for me |

Four invariants:

- **An identity is an origin.** One agent per origin. The origin's key directory is the only source of its keys.
- **The trust record is derived, never pointed to.** A verifier computes its location from the origin. Nothing on the wire, and nothing the agent says, chooses which record counts.
- **First contact grants identity, never authority.** A verified signer that the seller has never seen is *identity-established*: it gets what an anonymous caller gets. Authority comes from grants and seller onboarding.
- **The 3.2 profile keeps working.** brand.json, `identity.brand_json_url`, and `jwks_uri` remain valid through 3.x. Removal is 4.0.

## Problem

AdCP specifies everything after a buyer agent is known to a seller and almost nothing about how it becomes known.

- **A seller cannot identify a signer it has not onboarded** (#7814). A signed request carries only a `keyid`, which is not namespaced, so the agent URL is exchanged out of band.
- **Every signing buyer must run a capabilities endpoint.** Discovery step 1 calls `get_adcp_capabilities` on the signer, and "Shortcuts must be bound both ways" makes an onboarding record re-confirm against it. `@adcp/sdk` enforces both. A buyer that is only a client must stand up an MCP or A2A server to answer one call, and the capabilities schema has no valid buyer-only shape (`supported_protocols` requires a seller protocol). See #6105 and #8115.
- **trust.json would keep the requirement.** Resolution step 1 in `brand-identity-trust-split.md` still fetches the agent's capabilities for `identity.trust_url`.
- **Authority is not publicly checkable.** Who an agent may act for lives in the seller's onboarding record or brand.json `authorized_operators[]` (#6033).
- **Commercial onboarding is undiscoverable** (#8113). "Invite-only", "not onboarded yet", and "wrong credential" look the same on the wire, so a human at the buyer searches each seller's website.
- **Approval lapses are only discovered on failure.** `AGENT_SUSPENDED` arrives on the next call, possibly mid-flight.

## The end-to-end flow

Characters follow the [character bible](./character-bible.md): Sam's buyer agent at Pinnacle Agency onboards with StreamHaus (Priya).

| Step | Buyer (Pinnacle) | Seller (StreamHaus) | Delivered by |
|---|---|---|---|
| 0. Publish | Serves its key directory at `https://buyer.pinnacle-agency.example`. Lists that origin in `https://pinnacle-agency.example/.well-known/trust.json` with role `adcp:buying`. Each advertiser it acts for grants `pinnacle-agency.example` the `adcp:media_buying` scope in its own trust.json. | — | P1, P2, P5 |
| 1. Discover | Registry or `adagents.json` | — | existing |
| 2. Read posture | Unsigned `get_adcp_capabilities`, reads `account.agent_onboarding` | Publishes a mode per billing party, a sandbox mode, and requirements | P6 |
| 3. Self-qualify | Checks each requirement against its own trust record, badges, and billing | — | P6 |
| 4. First contact | Signed `get_principal` with a covered `Signature-Agent` naming its origin | Verifies through the directory and derives the trust record. Returns `unconfigured` with `relationship` (R8). For an `open` mode, creates a principal limited to that mode (R5). | P2, P3, P4 |
| 5. Configure | `sync_principal` once a principal exists | Principal record keyed by the origin | existing, P4 |
| 6. Accounts | `sync_accounts` per advertiser | Checks the advertiser's grant (R6). Open and in limits: `active`. Otherwise `pending_approval` with `setup.url`. | P5, P6 |
| 7. Stay current | `get_principal`, `principal.changed` | Relationship status and `expires_at` | P4 |

## Decisions

| # | Decision | Rationale |
|---|---|---|
| D1 | **First-contact signer identity uses the Web Bot Auth `Signature-Agent` header** (#7878 option A), as an optional, capability-advertised, experimental profile in 3.3. #7817 closes as superseded. | The IETF `webbotauth` working group adopted the protocol draft. It defines the header, directory, caching, and fetch rules. The #7878 joint brief preferred A over B; `adcp-agent-url` would polish a surface 4.0 retires. |
| D2 | **One identity per origin, one key purpose per origin.** An origin that hosts more than one agent is ineligible for the profile; those agents move to subdomains or stay on the 3.2 profile. A governance agent is its own origin (#7878 gate 3, mechanism A). | Keys, revocation, and the trust record all derive from the origin. Refusing shared origins avoids merging principals. One purpose per origin replaces `identity.key_origins`. |
| D3 | **Keys live only in the identity origin's directory.** Remove `agents[].jwks_uri`, the `/.well-known/jwks.json` default, and the "MUST point back via `identity.trust_url`" text from trust.json v1 before 3.3 beta.0. | Agreed on #7819. #8067 shipped them in the experimental schema, but nothing has released it, so no notice period applies. |
| D4 | **The trust record is derived:** `https://{eTLD+1(origin)}/.well-known/trust.json`, with at most one `authoritative_location` hop. No `identity.trust_url`, no capabilities back-pointer. | Under D2 and D3 the record only attests role and operator. The registrable-domain owner already controls every origin under it. Probing exactly one location avoids the "several records list A" ambiguity. |
| D5 | **The 3.2 profile stays through 3.x** and is not deprecated in 3.3. **#7942's client-only bootstrap does not ship.** | Client-only buyers use the WBA profile with static files only, and get first contact too. A third bootstrap adds cost without a case it alone covers. |
| D6 | **Key revocation for WBA identities is published at the identity origin; agent revocation is the operator delisting the origin.** The 3.2 profile is unchanged. | Key facts live at one origin; the operator keeps a lever when that origin is compromised (R3, freshness). |
| D7 | **Demand-side grants (#6033) move into 3.3.** | Without public grants, a seller cannot verify acts-for without an onboarding record, and self-onboarding stops at identity. |
| D8 | **Onboarding posture by billing party.** Seller: `account.agent_onboarding` with a mode per `billing-party` value plus a sandbox mode. Buyer: an `onboarding` slot in the trust.json agent profile, with its own enum. | Sandbox carries no spend, and operator-billed spend can be bounded by an existing billing relationship and a grant (R7), so both can be open. Keying by billing party answers #8113 open question 1 with the existing enum. |
| D9 | **`get_principal` reports relationship status and `expires_at`**, including before a principal exists, and `principal.changed` fires before a lapse. | The caller is authenticated, so per-agent state is safe to return. |
| D10 | **Out of scope: agents accepting contracts** on an operator's behalf. Recorded as a known limitation. | A legal question first. See #6520 and #7064. |
| D11 | **auth.md and OAuth sellers get an informative mapping only.** | Same identity everywhere, without a normative dependency on a young single-vendor spec. |
| D12 | **A 3.3 scope-freeze date is published.** | The #7878 gates and this program depend on it. |

## Proposed normative rules

Rules here are proposals. Each lands in the PR named, in the page named, and nowhere else.

### R1. Identity and keys (P2, WBA profile page)

- A WBA identity is an HTTPS origin `O`, canonicalized with the shared [URL canonicalization algorithm](../docs/reference/url-canonicalization.mdx): lowercase A-label host, default port elided, no path.
- An origin hosts at most one agent. `agents[].url` values in a trust record that share an origin are invalid, and the validator rejects them. The agent's endpoint URL (`agents[].url`, which may carry a path) is the address to call; the origin is the identity.
- Every key in the directory carries `adcp_use`. Verifiers enforce it per surface, as `security.mdx` §Key separation does for JWKS today. An origin publishes keys for one purpose: request signing (which also signs its webhooks), or governance signing. This replaces the `identity.key_origins` consistency check for WBA identities.

### R2. Signer identity on signed artifacts (P2)

**HTTP requests and webhooks.**
- The signer sends `Signature-Agent` as a dictionary member keyed by its signature label, `sig1="https://buyer.pinnacle-agency.example"`, and covers it as `"signature-agent";key="sig1"`.
- Requests use the `web-bot-auth` tag. Webhooks keep their existing AdCP webhook tag and also cover `Signature-Agent`, so a captured request signature cannot be replayed as a webhook or the reverse.
- The header is covered the same way on every A2A binding that carries HTTP headers (JSON-RPC, HTTP+JSON, and gRPC metadata). P2 lists the binding-specific component names.

**JWS artifacts** (governance context, designated-task response signing, rights attestations), **3.4**.
- `O` is the canonical origin of `iss` (or of `agent_url` where the surface uses it). In 3.3, these surfaces use the 3.2 chain only.

**Profile selection.**
- A signed HTTP message that carries `Signature-Agent` or the `web-bot-auth` tag is verified under R3 only, never under the 3.2 profile. A present but uncovered `Signature-Agent` is rejected, not ignored.
- For a JWS (from 3.4), the verifier uses R3 when the trust record derived from `O` lists `O`. Otherwise it uses the 3.2 chain, unless R4 forbids that. Profile selection never reads an unsigned field.
- A request MAY carry two signatures, one per profile, only to bind a WBA identity onto an existing 3.2 principal (R5 rule 4). Both MUST verify.

**Draft revision.** The capability advertisement names the WBA draft revision the profile implements. A later revision with wire changes is a new profile identifier, advertised alongside the old one, so draft churn never silently changes what a verifier accepts.

**Untrusted until verified.** The header is an untrusted claim until the signature verifies. A verifier MUST NOT log it, use it as a metric label, or fetch with it before the checks that need no network have passed.

### R3. Agent resolution v2 (P3, `security.mdx`)

Given origin `O` from R2:

1. **Directory.** Fetch `https://O/.well-known/http-message-signatures-directory` under the WBA fetch rules: zero redirects, body cap, budgets, negative cache at most 60 s. Look up the key by `(O, kid)`, where `kid` is the RFC 7638 thumbprint, and check its `adcp_use` for the surface. Verify the signature, the nonce, and the window.
2. **Key revocation.** Check the identity's revocation list at `O` (path defined in P2). Fail closed for spend-committing operations.
3. **Derive the trust record.** `R = https://{eTLD+1(host(O))}/.well-known/trust.json`, using a pinned, dated Public Suffix List snapshot that includes the ICANN and PRIVATE sections.
   - Reject `O` before any fetch if its host is an IP literal, is itself a public suffix, or has no defined eTLD+1.
   - Fetch `R`, and any hop, under the `security.mdx` Webhook URL validation SSRF rules: zero redirects, a 2 MiB streaming body cap, strict parsing with duplicate keys rejected, nesting depth 32.
   - Follow at most one `authoritative_location` hop. The target document MUST NOT itself carry `authoritative_location`.
   - The **operator is `eTLD+1(host(O))`**: never a value inside the document, and never the host of an `authoritative_location` target.
4. **Match.** Exactly one `agents[]` entry has a canonical origin equal to `O` and carries the role the surface requires. No match: reject with `request_signature_agent_not_in_trust_record`. More than one: reject as ambiguous. If the entry carries `key_thumbprints`, the key from step 1 MUST be one of them. The pin narrows keys and never adds any.
5. **Result.** The verified identity is `O`, and the operator is `eTLD+1(host(O))`. Authority is evaluated separately (R3b, R6).

There is no capabilities fetch. An `identity.brand_json_url` on the agent's capabilities plays no part in WBA-profile resolution.

**One external code.** Every failure in steps 3 and 4 returns one externally visible code. The cause (unreachable, malformed, unlisted, hop rejected) goes to logs only, so resolution cannot be used to probe what the verifier's network reaches.

**Freshness and operator revocation.** A binding (R5) is a cache of steps 3 and 4, not a standing grant.
- Verifiers MUST re-derive the trust record at least as often as the revocation polling interval in `security.mdx`, and before a spend-committing call when the cached record is older than that interval.
- A fetch failure is not absence. Fail closed for spend-committing operations.
- An operator revokes an agent by delisting its origin. Delisting ends the agent's identity, and every grant that reaches it through the operator, within one cache lifetime. This is the operator's lever when the origin itself is compromised, since a compromised origin also serves its own revocation list.
- Verifiers MUST retain every key revocation they have seen for `O`. An origin cannot un-revoke a key.

**Abuse limits.**
- Rate-limit and negative-cache resolution by canonical host, by eTLD+1, and by `authoritative_location` target host, not by URL. Single-flight concurrent fetches.
- Cap concurrent and per-window resolutions of new origins.
- Reject before any fetch if the header is not covered.

**Cross-organization hosting.** A platform that runs an agent for a brand lists the agent in its own trust record; the brand grants the platform's domain (R6). There is no hosting-delegation fallback, matching `brand-identity-trust-split.md` §Agent resolution step 3.

### R3b. Relying-party authorization (3.4, with the JWS surfaces)

A role in the agent's own record is the operator's claim about itself. It is sufficient only where the surface needs no one else's consent: buyer requests (`adcp:buying`), and sell-side signatures (`adcp:sales`) together with the publisher's `adagents.json`. On every other surface the relying party consents:

| Surface | Relying-party record | Required |
|---|---|---|
| Governance context `iss` | the buyer's | the buyer's operator is `eTLD+1(host(O))`, or holds a grant to it with `adcp:governance` |
| Designated-task response signing (`brand_domain` cross-check) | the brand's | the brand's operator is `eTLD+1(host(O))`, or holds a grant to it with `adcp:brand_identity` |
| Rights attestations | the rights holder's | the rights holder's operator is `eTLD+1(host(O))`, or holds a grant to it with `adcp:rights_clearance` |

**Publisher pins.** `adagents.json` `signing_keys` pins match by RFC 7638 thumbprint, so they apply to directory keys unchanged and narrow only. `authorized_agents[].url` is matched against `O` by canonical origin.

### R4. Coexistence with the 3.2 profile (P3)

- Signed messages without `Signature-Agent` or the `web-bot-auth` tag, and JWS artifacts selected for the 3.2 chain (R2), are verified under the 3.2 profile, unchanged.
- **No downgrade, keyed by origin.** A verifier refuses the 3.2 profile for any agent URL whose origin is `O`, on every surface that R3 covers, once either of these holds:
  - the verifier has bound `O` (R5);
  - the trust record derived from `O` lists it with a `profiles.adcp.signing_profiles` that omits `adcp-rfc9421` (for example `["wba"]`). The operator sets this to opt out of 3.2 before any seller binds.
- **No downgrade for grants.** When the grantor's trust.json fetch returns 200, its `grants[]` is the grantor's only published source of grants, and `authorized_operators[]` in its brand.json is ignored, so a stale brand.json entry cannot outlive its removal from trust.json. A failed fetch never counts as "no trust.json".
  - This does not change what `exclusive_grants` means. With `exclusive_grants: false`, an acts-for claim no grant covers stays at the relying party's discretion. That discretion is the seller's own onboarding records and policy, never the grantor's brand.json.
  - Under an `open` mode, R7 removes that discretion for brands outside the buyer's operator domain: a missing grant is a deny.
- trust.json no longer carries keys (D3). In 3.3 it is consumed for WBA identities (R3), relying-party consent (R3b), and grants on either profile (R6).

### R5. First contact and principal binding (P4, `L2/accounts-and-agents.mdx`)

These are the four binding rules from gate 2 of `specs/wba-profile-readiness.md` (on the [#7942](https://github.com/adcontextprotocol/adcp/pull/7942) branch). Rule 1 carries the rewording from [#7942 comment 6087434878](https://github.com/adcontextprotocol/adcp/pull/7942#issuecomment-6087434878), and rule 4 is tightened.

1. **Verification alone never creates a principal.** A verified origin with no binding is *identity-established*: it gets what an anonymous caller gets, reads included, plus `get_principal` (R8). A principal comes only from a binding under rule 2. That includes the binding a seller creates when it approves a new identity.
2. A binding is an explicit, audited seller record from origin to principal.
3. An origin maps to at most one principal.
4. A seller binds onto an existing 3.2 `agents[].url` principal only when the origin is unambiguous, **and** only through one of:
   - a request carrying both a valid 3.2 signature and a valid WBA signature (R2);
   - explicit out-of-band seller approval.

   In 3.2, controlling the agent's host was not enough to obtain its keys, and this rule keeps origin control alone from inheriting an existing principal. This binding is never automatic.

**Automatic binding.** Where the seller declares an `open` mode (R7), it MAY create a **new** principal on first contact. That principal is limited to the open modes. Anything else stays `pending_approval` until a seller approves it.

### R6. Authority: grants (P5)

- **Which record authorizes.** At `sync_accounts`, the authorizing record is the **brand's** trust record, or its house record when the brand has one. The buyer's operator record never authorizes a brand outside the operator's registrable domain.
- **Matching a grant.** The seller looks for a grant whose `grantee` exactly equals the buyer's operator domain (R3 step 5), compared as a registrable domain, with a scope covering the operation (`adcp:media_buying` for buys).
  - A grant's `agents[].url` narrowing matches the buyer by canonical origin.
  - Grants for `adcp:media_buying` SHOULD narrow with `agents[]`, because a grant to a platform's domain otherwise covers every agent that platform lists.
- **Chain length.** The chain is at most brand → grantee, or brand → grantee → the grantee's single onward grant where `brand-identity-trust-split.md` §Grants permits one. Effective authority is the intersection of brands, countries, scopes, and the earliest `valid_until` along the chain. Nothing extends further.
- **What a grant isn't.** Grants never carry keys and are evaluated at the grantor's document only.
- **brand.json fallback.** Through 3.x, brand.json `authorized_operators[]` remains a valid source when the grantor has no trust.json, subject to R4.

### R7. Onboarding posture (P6, `get_adcp_capabilities.mdx`)

Shape (experimental feature `account.agent_onboarding`):

```json
{
  "account": {
    "supported_billing": ["operator", "agent"],
    "sandbox": true,
    "agent_onboarding": {
      "sandbox": { "mode": "open" },
      "billing": {
        "operator": { "mode": "open", "requirements": [{ "kind": "grant" }] },
        "agent": {
          "mode": "application",
          "requirements": [{ "kind": "billing_entity" }, { "kind": "contract" }]
        }
      },
      "url": "https://streamhaus.example/partners/buyer-agents",
      "documentation_url": "https://docs.streamhaus.example/adcp",
      "message": "Sandbox is open to any verified buying agent. Operator-billed accounts are open when your operator already bills with us and the advertiser has granted your operator."
    }
  }
}
```

**Shape.**
- `billing` is keyed by `enums/billing-party.json` values (`operator`, `agent`, `advertiser`). Its keys MUST be a subset of `supported_billing`. `sandbox` is valid only when `account.sandbox` is true.
- Modes: `open`, `application`, `invite_only`. An absent key means undeclared, not `invite_only`. Prepaid funding is not a mode; `payment_required` already covers it.
- Requirement kinds are closed, `x-extensible`, and named in trust.json terms: `agent_identity` (a trust record entry with the required role), `grant` (R6), `billing_entity`, `contract`, `credit_application`. An unknown kind falls back to `message` and `url`.

**What `open` means.**
- `open` requires identity established from the agent's published keys (R3), whether by request signature or the R9 assertion. A seller that only maps opaque, seller-issued credentials cannot declare it.
- `open` binds identity, not spend. Under any `open` mode:
  - when the account's brand is outside the buyer's operator domain, a missing grant (R6) MUST be treated as deny;
  - spend-committing operations billed to `operator` require an existing seller-side billing relationship with the billed operator domain;
  - quotas and rate limits for automatic binding are counted per operator domain, not per origin;
  - an origin whose registrable domain comes from the PSL PRIVATE section, such as a tenant subdomain of a hosting platform, is eligible for `sandbox` only.

**Uniformity.** The block is seller-wide, identical for every caller, served on the unauthenticated fetch, and absent from error payloads. The oracle clamps in `error-handling.mdx` are unchanged.

**Buyer posture (#8114)** goes in `agents[].profiles.adcp.onboarding` in the buyer's trust record. Its modes are distinct from the seller's: `considers_unsolicited`, `application`, `invite_only`.

### R8. Relationship status (P4, `get_principal.mdx`)

- `get_principal` adds `relationship: { status, expires_at }` on the `unconfigured`, `recognized`, and `current` results. `relationship` is **omitted** when the seller has no relationship with the caller and no application in progress, which is the identity-established state of R5 rule 1. Status values, when present:
  - `pending`: an application or approval is in progress;
  - `active`;
  - `suspended`;
  - `blocked`.
- It is returned only to the authenticated caller, so an identity-established agent can see that its application is pending. P4 opens the closed `unconfigured` schema (`get-principal-response.json`) for this one field.
- `principal.changed` adds the reasons `relationship_changed` and `relationship_expiring`. The second fires at a seller-declared lead time before `expires_at`; `setup_expiring` is the precedent.

### R9. OAuth and auth.md sellers (P8, informative)

A seller that issues bearer tokens can accept the same identity with an RFC 7523 JWT-bearer assertion. The assertion is signed by a request-signing key in the agent's directory and resolved under R3, with `O` taken from the assertion's `iss`. `agent_onboarding.url` MAY point to the seller's `auth.md`.

## Threat model deltas

| Threat | Control |
|---|---|
| Header names a victim's origin | The signature must verify under that origin's directory key. The header is untrusted until then (R2). |
| Stripping header coverage to force the 3.2 profile | A present `Signature-Agent` or `web-bot-auth` tag means WBA only. Uncovered is rejected (R2). |
| Attacker lists a victim origin in the attacker's own trust record | Only the record at the origin's registrable domain counts (R3 step 3). |
| Attacker lists its own agent as `adcp:governance` | A role is identity only. The relying party must consent (R3b). |
| Request signature replayed as a webhook | Distinct tags, each covering `Signature-Agent` (R2). |
| Subdomain takeover (dangling CNAME) of a listed origin | The origin inherits its operator's grants unless they narrow with `agents[]` (R6). Operators SHOULD pin with `key_thumbprints` (R3 step 4). Delisting revokes within one cache lifetime (R3, freshness). Sellers SHOULD alarm on key-set changes for bound identities. |
| Compromised origin serves an empty revocation list | Verifiers retain seen revocations; the operator delists (R3, freshness). |
| Origin control used to take over a 3.2 principal | Binding onto a 3.2 principal needs a dual-signed request or out-of-band approval (R5 rule 4). |
| Downgrade to a stale 3.2 key | No downgrade keyed by origin, with an operator opt-out before binding (R4). |
| Stale brand.json grants override trust.json | A 200 from trust.json disables `authorized_operators[]` (R4). |
| Anonymous party opens operator-billed accounts | `open` binds identity only; spend needs an existing billing relationship, and an out-of-domain brand needs a grant (R7). |
| Free registrable domains on hosting platforms defeat quotas | PRIVATE-section domains are `sandbox` only; quotas per operator domain (R7). |
| Resolution as a fetch amplifier, including many domains pointing at one `authoritative_location` target | Limits by host, eTLD+1, and target host; single-flight; one hop; checks before fetch (R3). |
| Resolution failures used as a network probe | One external code for step 3 and 4 failures (R3). |
| Posture used as an onboarding oracle | Seller-wide, unauthenticated, uniform block. Per-agent state only in authenticated `get_principal` (R7, R8). |
| PSL drift between verifiers | Pinned, dated snapshot, as `security.mdx` already requires. |

## Known risks and dissent

| Risk | Position |
|---|---|
| **Draft maturity.** WBA is an adopted IETF draft (-00), and the `Signature-Agent` format already changed once (directory-03 to the dictionary form). | Experimental and capability-advertised; the profile identifier pins the draft revision (R2); the 3.2 profile is untouched. |
| **Deployed edge verifiers.** Cloudflare's documented verifier rejects the dictionary form and does not enforce nonces; AWS WAF, Vercel, and Akamai publish nothing (#7878 gate 1). | AdCP sellers verify at their origin with the SDKs, and replay enforcement stays with the AdCP deployment. An edge verifier is an optimization, not a dependency. The interop matrix is tracked, not a blocker. |
| **One identity per origin.** Path-hosted agents must move to subdomains. Multi-tenant sales platforms whose path-based URLs appear in many publishers' `adagents.json` files cannot move without those files changing. | The problem being solved is buyer to seller, and buyers can add subdomains cheaply. Path-hosted sellers keep 3.2 webhook signing until they migrate; nothing forces them. |
| **Directory upkeep.** Signed directory responses expire, so publishing keys is a scheduled job, not a static upload. | SDK CLIs provide a regenerate command (P2, SDK workstream); the walkthrough (P8) shows a scheduled job. |
| **Two profiles through 3.x.** SDKs and verifiers maintain both. | Accepted. Recorded dissent: the #7878 author prefers deprecating the 3.2 profile in 3.3. This design keeps it undeprecated until the interop matrix exists (joint brief Q2). |
| **Document signing.** Governance and rights JWS need key-purpose isolation and historical provenance. | Deferred to 3.4 (Scope of 3.3, above). |

## Compatibility and migration

- **Additive in 3.3.** The WBA profile, derived trust records, relying-party consent, grants, posture, and relationship status are experimental and capability-advertised. The 3.2 profile is unchanged.
- **One breaking change to an experimental surface:** the trust.json v1 edits in D3. They must merge before 3.3 beta.0.
- **Buyers** may publish a directory and trust record now. Dual-signing is needed only to carry an existing 3.2 principal over (R5 rule 4). A seller that does not advertise the WBA profile keeps verifying 3.2 signatures.
- **Sellers** advertise the WBA profile per operation, as with `request_signing` today.
- **Agencies hosting several agents on one origin** move each agent to its own subdomain before adopting the profile.
- **4.0** removes the 3.2 profile, the brand.json trust fields, and `identity.brand_json_url` (`brand-identity-trust-split.md` §Migration).

## Plan

| PR | Scope | Changeset |
|---|---|---|
| **P0** | This spec | none |
| **P1** | trust.json v1 edits:<br>- remove `agents[].jwks_uri`, its default, and the "point back via `identity.trust_url`" text;<br>- one-agent-per-origin rule, with a validator wired into `npm test`;<br>- `profiles.adcp.signing_profiles` and the optional `agents[].key_thumbprints` pin;<br>- canonical-origin matching for grant `agents[].url`;<br>- examples moved to one origin per agent.<br>The "nothing consumes this in 3.3" wording stays until P3 lands a consumer; the onboarding slot moves to P6. | minor |
| **P2** | WBA signing profile (#7894 rebased onto P1): R1, R2, directory with `adcp_use`, thumbprint `keyid`, nonce, window, request and webhook tags, A2A bindings, revocation at the origin, capability advertisement, vectors including governance 001–003 | minor |
| **P3** | Agent resolution v2 (R3) and coexistence (R4) in `security.mdx` for request signing and webhooks; R3b and the JWS surfaces stated as 3.4; new codes in `request-signing-error-code.json`; reverse "nothing consumes this in 3.3" in the trust.json schema, `trust-json.mdx`, `experimental-status.mdx`, and release-docs #8074 | minor |
| **P4** | First contact and binding (R5); relationship status (R8), including the `get-principal-response.json` and `principal-changed-webhook.json` changes | minor |
| **P5** | Grants (R6, #6033) | minor |
| **P6** | Onboarding posture (R7, #8113), including the `profiles.adcp.onboarding` slot in trust.json for the buyer posture (#8114) | minor |
| **P7** | Conformance:<br>- dual-source storyboards;<br>- derived-record, relying-party, downgrade, and WBA vectors;<br>- an end-to-end self-onboarding storyboard;<br>- the training agent verifies WBA, serves its own directory and trust record, and opens the sandbox mode. | minor |
| **P8** | Docs:<br>- a "A buyer agent onboards itself" walkthrough;<br>- rewrites of `request-signing.mdx` and `brand-protocol/seller-setup.mdx`;<br>- updates to `brand-json.mdx`, `trust.mdx`, `security-model.mdx`, `L2/authentication.mdx`, operating guides, learning tracks, glossary, and `known-limitations.mdx` (D10);<br>- the R9 mapping. | patch |
| **P9** | Migration guide `docs/reference/migration/agent-identity-3-3.mdx`, by role (buyer signer, seller verifier, agency or operator, SaaS platform, governance agent), with an SDK version table and rollback; entries in `3-2-to-3-3.mdx`, `whats-new-in-3-3.mdx`, and release notes | patch |
| R1 (follow-on) | Registry crawl of trust records and posture; requirement-match filter | — |

### SDK workstream

| Change | JS | Python | Go |
|---|---|---|---|
| Accept extra covered headers (ship first) | — | — | S |
| WBA signer: `Signature-Agent`, nonce, thumbprint `kid`, tags (opt-in); CLI to generate and re-sign the key directory | S | S | S |
| WBA verifier with a resolver for many signers, keyed by the header or `iss` | M | M (fixes adcp-client-python#1214) | S–M |
| Derived trust-record resolver, relying-party consent, capabilities optional, 3.2 fallback with no downgrade | M–L | M–L | L |
| Grant verification, posture and relationship types | S–M | S–M | S–M |
| Hook for identity-established signers | S–M | S–M | S–M |

Tracking: adcp-client#3098, adcp-client-python#1283, adcp-go#548 and #109. Each SDK publishes a migration note linked from P9.

## Open questions

1. **Revocation path name.** #7894 uses `/.well-known/governance-revocations.json` at the identity origin. Should request-signing and governance identities use one neutral name?
2. **Lead time for `relationship_expiring`.** Seller-declared, or a protocol minimum?
3. **`authoritative_location` binding.** Should the hop target be required to name the pointing registrable domain, so many domains cannot share one hosted document? It would cost multi-domain operators a document per domain.
