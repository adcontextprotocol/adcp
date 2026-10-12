# Agent identity and buyer self-onboarding (3.3)

**Status**: Accepted. The WG approved D1–D6 and the WBA error contract at the working session on 2026-10-12 ([decision brief on #7878](https://github.com/adcontextprotocol/adcp/issues/7878#issuecomment-6099382406)); recorded as [DR-0023](../governance/decisions/DR-0023-agent-identity-is-an-origin.md). The WG also approved D7 (demand-side grants) at the same session; its rules (R6) and record (DR-0025) are in #8157. D8 and D9 are decided on their issues. Tracking issue: [#8118](https://github.com/adcontextprotocol/adcp/issues/8118).

**Related**: [#7878](https://github.com/adcontextprotocol/adcp/issues/7878) / [#7894](https://github.com/adcontextprotocol/adcp/pull/7894) (Web Bot Auth profile), [#7817](https://github.com/adcontextprotocol/adcp/issues/7817) (`adcp-agent-url`), [#7814](https://github.com/adcontextprotocol/adcp/issues/7814) (unknown signers), [`brand-identity-trust-split.md`](./brand-identity-trust-split.md) (trust.json, RFC [#7809](https://github.com/adcontextprotocol/adcp/issues/7809)), [#7942](https://github.com/adcontextprotocol/adcp/pull/7942) and [#6105](https://github.com/adcontextprotocol/adcp/issues/6105) (client-only signers), [#6033](https://github.com/adcontextprotocol/adcp/issues/6033) (demand-side grants), [#8113](https://github.com/adcontextprotocol/adcp/issues/8113) / [#8114](https://github.com/adcontextprotocol/adcp/issues/8114) (onboarding posture), [#7015](https://github.com/adcontextprotocol/adcp/issues/7015) (principal layer).

**Supersedes**, for Web Bot Auth identities, these parts of `brand-identity-trust-split.md`:
- the `identity.trust_url` back-pointer;
- "Every discovery path is bound both ways" (§Agent resolution);
- the acknowledgement "point back" rule (§Acknowledgements).

It also supersedes the client-only bootstrap in #7942 and option B (`adcp-agent-url`) in #7817.

**Scope of 3.3**: the WBA profile covers signed **HTTP requests and webhooks**. JWS artifacts (governance context `iss`, designated-task response signing, rights attestations) stay on the 3.2 chain in 3.3. They move in 3.4 with a provenance contract for governance keys, because a retained directory response proves key possession, not publication at a point in time (#7878 gates 3 and 4). The [appendix](#appendix-34-direction-for-jws-surfaces-non-normative) records the intended direction, non-normatively.

**Not in scope**: TMP, whose match-time signatures use publisher keys from the property registry, as `security.mdx` §Agent resolution already says.

**Principle**: use what Web Bot Auth, RFC 9421, and existing AdCP text already define, and add nothing to the WBA layer. A signer built with any conforming WBA library must verify against an AdCP verifier. Where a rule here would restate the draft, it cites the draft instead.

New names in this document are new to AdCP: the WBA profile in AdCP, the revocation list's `revocation_details` (RFC 5280 reason codes and invalidity dates), `agent_onboarding`, `relationship`, the new `principal.changed` reasons, and the "canonical origin" definition. The trust.json roles and scopes used here are already defined in `static/schemas/source/trust/v1/trust.json`.

## TL;DR

A buyer agent publishes its keys and a trust record. It can then make itself known to any AdCP seller that supports the profile. It does not serve `get_adcp_capabilities` and receives no seller-issued credential. The signature is the credential.

| File | Where | Says |
|---|---|---|
| Key directory | `https://{agent origin}/.well-known/http-message-signatures-directory` | This origin's signing keys (Web Bot Auth). The response is signed per key with `created` and `expires` (WBA Appendix B.1), so it is regenerated on a schedule. |
| Trust record | `https://{registrable domain}/.well-known/trust.json` | This origin is my agent, with these roles; these organizations may act for me |

**What `open` onboarding delivers.** A verified identity, sandbox access, and joining a billing relationship that already exists (operator- or advertiser-billed). It does not let an unknown agent start spending: agent-billed accounts and new commercial relationships still go through the seller's application (R7). Self-onboarding automates becoming known, and a human stays involved wherever the seller takes on new risk.

Four invariants:

- **An identity is an origin.** One agent per origin. The origin's key directory is the only source of its keys.
- **The trust record is derived, never pointed to.** A verifier computes its location from the origin. Nothing on the wire, and nothing the agent says, chooses which record counts.
- **First contact grants identity, never authority.** A verified signer that the seller has never seen is *identity-established*: it gets what an anonymous caller gets. Authority comes from grants and seller onboarding.
- **The 3.2 profile keeps working through 3.x.** brand.json, `identity.brand_json_url`, and `jwks_uri` remain valid. The profile is deprecated in 3.3 and removed in 4.0.

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
| 4. First contact | Signed `get_principal` with a covered `Signature-Agent` naming its origin | Verifies the signature against the origin's directory: identity-established. Returns `unconfigured`, with `relationship` when one exists (R8). | P2, P3, P4 |
| 5. Configure | `sync_principal` | Where an `open` mode applies, evaluates the trust record (R3a) and creates a principal limited to the open modes (R5). Otherwise the seller's approval is required. | existing, P4 |
| 6. Accounts | `sync_accounts` per advertiser | Checks the grant (R6). Open and within limits: `active`. Otherwise `pending_approval` with `setup.url`. | P5, P6 |
| 7. Stay current | `get_principal`, `principal.changed` | Relationship status and `expires_at` | P4 |

## Decisions

| # | Decision | Rationale |
|---|---|---|
| D1 | **First-contact signer identity uses the Web Bot Auth `Signature-Agent` header** (#7878 option A), as an optional, capability-advertised, experimental profile in 3.3. #7817 closes as superseded. | The IETF `webbotauth` working group adopted the protocol draft. It defines the header, directory, caching, and fetch rules. `adcp-agent-url` would polish a surface 4.0 retires. |
| D2 | **One agent per origin; a governance agent is its own agent.** An origin that hosts more than one agent is ineligible for the profile; those agents move to subdomains or stay on the 3.2 profile. | Keys, revocation, and the trust record all derive from the origin. Refusing shared origins avoids merging principals. `security.mdx` already requires governance keys on a separate origin; with origin identity, that rule is the whole key-purpose mechanism (WBA §6.5). |
| D3 | **Keys live only in the identity origin's directory.** Remove `agents[].jwks_uri`, the `/.well-known/jwks.json` default, and the "MUST point back via `identity.trust_url`" text from trust.json v1 before 3.3 beta.0. | Agreed on #7819. #8067 shipped them in the experimental schema, but nothing has released it, so no notice period applies. |
| D4 | **The trust record is derived:** `https://{eTLD+1(origin)}/.well-known/trust.json`, with at most one `authoritative_location` hop. No `identity.trust_url`, no capabilities back-pointer. It is evaluated where it gates something (binding, grants, `open` onboarding), not on the signature path. | Under D2 and D3 the record only attests role and operator. The registrable-domain owner already controls every origin under it. In WBA, identity is complete once the directory key verifies (WBA §4.1). |
| D5 | **The 3.2 profile is deprecated in 3.3, stays fully functional through 3.x, and is removed in 4.0. #7942's client-only bootstrap does not ship.** | `versioning.mdx` requires a deprecation notice at least 6 months before removal, and `brand-identity-trust-split.md` already plans to remove the 3.2 key chain in 4.0. The notice tells the next implementer to build WBA. A client-only bootstrap would be a second first-contact mechanism. |
| D6 | **Key revocation for WBA identities is published at the identity origin; agent revocation is the operator delisting the origin.** The 3.2 profile is unchanged. | Key facts live at one origin; the operator keeps a lever when that origin is compromised (R3a, freshness). |
| D7 | **Demand-side grants (#6033) move into 3.3.** | Without public grants, a seller cannot verify acts-for without an onboarding record, and self-onboarding stops at identity. |
| D8 | **Onboarding posture by billing party.** Seller: `account.agent_onboarding` with a mode per `billing-party` value plus a sandbox mode. Buyer: an `onboarding` slot in the trust.json agent profile, with its own modes. **P6 ships on its own**: only `open` and the `grant` kind wait for the identity PRs. | Sandbox carries no spend, and spend under `open` is bounded by an existing billing relationship and a grant (R7). Keying by billing party matches the first question onboarding teams ask (#8113). |
| D9 | **`get_principal` reports relationship status and `expires_at`**, including before a principal exists, and `principal.changed` fires before a lapse. | The caller is authenticated, so per-agent state is safe to return. |
| D10 | **Out of scope: agents accepting contracts** on an operator's behalf. Recorded as a known limitation. | A legal question first. See #6520 and #7064. |
| D11 | **OAuth and auth.md sellers get an informative mapping in the docs (P8), not a rule.** | Same identity everywhere, without a normative dependency on a young single-vendor spec. |
| D12 | **The 3.3 scope freeze is 2026-10-26.** | The identity PRs and the #7894 rebase land before it. |

D7, D8, and D9 are features of their own (#6033, #8113, #8114, #8118). The self-onboarding flow needs them; the identity decision (D1–D6) does not.

## Proposed normative rules

Each rule lands in the PR named, in the page named, and nowhere else. R9 was added after the 2026-10-12 session, following a WG question on what revocation means for live buys.

### R0. Canonical origin (P1, `url-canonicalization.mdx`)

The canonical origin of a URL is its scheme and authority after steps 1 to 4 of the [URL canonicalization algorithm](../docs/reference/url-canonicalization.mdx), with no path, query, or fragment. That page defines it once, with vectors, and its "Where it applies" table states which form each comparison uses:
- WBA identity and trust.json agent URLs compare canonical origins.
- `format-id.agent_url` stays a canonical URL. A WBA signer matches it when the canonical origin of `agent_url` equals `O`.
- `adagents.json` `authorized_agents[].url` stays a canonical URL under the 3.2 profile, and matches a WBA signer by canonical origin.

No other rule restates the definition.

### R1. Identity and keys (P2, WBA profile page)

- A WBA identity is a canonical origin `O` (R0).
- An origin hosts at most one agent, and a trust record listing two agents with the same canonical origin is invalid. The agent's endpoint URL (`agents[].url`, which may carry a path) is the address to call; the origin is the identity.
- The origin's key directory is the only source of its keys (WBA §5.5). Keys carry no AdCP-specific members. Purpose separation is by origin (D2).

### R2. Signer identity on requests and webhooks (P2)

- **Requests and webhooks** follow the WBA draft as written: a covered `Signature-Agent` member naming `O` (§5.2.1, §5.2.2), `tag="web-bot-auth"` (§5.2), and a `nonce`. A webhook is an ordinary WBA request from the seller's identity. Its covered `@method`, `@target-uri`, and `@authority`, plus the nonce, keep a request signature from verifying as a webhook or the reverse.
- **Profile selection.** A signed message that carries `Signature-Agent` or the `web-bot-auth` tag is verified under the WBA profile only, never under the 3.2 profile.
- **A2A.** RFC 9421 component names apply to every HTTP message, and `security.mdx` §Operation resolution over A2A already covers the bindings. There are no binding-specific component names.
- **Advertisement.** Capabilities advertise the profile with the identifiers #7894 uses in `request_signing.profiles` and `webhook_signing.profiles`: `web-bot-auth` and `adcp/request-signing/v1`. The WBA draft revision is a separate field next to `profiles`, so a later revision with wire changes is advertised alongside the old one.
- **Errors.** WBA defines the verifier's answer: `403` with `Accept-Signature`, `400` for headers that do not parse, and `429` for a reused signature or nonce. An AdCP error body, when sent, is the generic authentication error with no signature-specific detail. Conformance grades the status and headers only. The signature-specific `request_signature_*` codes remain for the 3.2 profile.

Everything else on the signature path is the draft's: attaching no policy until verification (§4.1), the `(O, key)` lookup (§5.4), fetch limits (§6.7), coalescing (Appendix C.3), and negative caching (Appendix C.5). AdCP chooses only its numbers, such as a negative cache of at most 60 s.

### R3. Identity verification (P3, `security.mdx`)

Identity is the signature verifying under a key from `O`'s directory, as the WBA draft defines it, plus a check of the identity's revocation list. That list is at `O`, at the existing `/.well-known/governance-revocations.json` path with the `adcp-gov-revocation+jws` type, and covers all of the identity's keys. Fail closed for spend-committing operations.

The result is the verified identity `O`. A signer whose trust record does not list it is still identity-established (R5 rule 1). There is no capabilities fetch, and no new request-signing error code.

### R3a. Trust record evaluation (P3, `security.mdx`)

Evaluated when something is gated on it: binding a principal (R5), evaluating a grant (R6), and `open` onboarding (R7). It is never evaluated on the signature path.

1. **Derive.** `R = https://{eTLD+1(host(O))}/.well-known/trust.json`, using a pinned, dated Public Suffix List snapshot that includes the ICANN and PRIVATE sections.
   - An `O` whose host is an IP literal or a public suffix, or has no defined eTLD+1, has no trust record.
   - Fetch `R` and any hop under the `security.mdx` Webhook URL validation SSRF rules, with the trust-record body cap and strict parsing.
   - Follow at most one `authoritative_location` hop. The target MUST NOT itself carry `authoritative_location`.
   - The **operator is `eTLD+1(host(O))`**, never a value inside the document.
2. **Match.** Exactly one `agents[]` entry has a canonical origin equal to `O` (R0) and carries the role the gate requires (`adcp:buying` for buyer binding and grants).
   - A failed match is an authorization outcome and returns the existing authorization error, one external code. The cause goes to logs only.

**Freshness and operator revocation.**
- A binding is a cache of R3a, not a standing grant. Verifiers MUST re-evaluate it at least as often as the revocation polling interval in `security.mdx`, and before a spend-committing call when the cached result is older than that.
- A fetch failure is not absence: fail closed for spend-committing operations (`brand-identity-trust-split.md` §Grants: "A fetch failure is never equivalent to absence").
- An operator revokes an agent by delisting its origin. That ends every binding and grant that reaches the agent through the operator within one cache lifetime. This is the operator's lever when the origin itself is compromised.
- Verifiers MUST retain every key revocation they have seen for `O`. An origin cannot un-revoke a key.

**Cross-organization hosting.** A platform that runs an agent for a brand lists the agent in its own trust record, and the brand grants the platform's domain (R6). There is no hosting-delegation fallback, matching `brand-identity-trust-split.md` §Agent resolution step 3.

### R4. Coexistence with the 3.2 profile (P3)

- Signed messages without `Signature-Agent` or the `web-bot-auth` tag, and every JWS artifact in 3.3, are verified under the 3.2 profile.
- **The 3.2 profile is deprecated in 3.3**, with a notice in `security.mdx` and the release notes. It remains fully functional through 3.x and is removed in 4.0, together with the brand.json trust fields and `identity.brand_json_url` (`brand-identity-trust-split.md` §Migration).
- **No downgrade, keyed by origin.** Once a verifier has bound `O` (R5), it refuses the 3.2 profile for any agent URL whose origin is `O`. Before binding, an operator ends 3.2 use for an agent by removing its brand.json entry and keys, which reaches every verifier within the JWKS cache bound.
- **Grants** follow `brand-identity-trust-split.md` §No downgrade and §Grants. A 200 from the grantor's trust.json makes it the only source of grants, and brand.json `authorized_operators[]` is ignored. `exclusive_grants` keeps its schema meaning: with `false`, an uncovered claim stays at the relying party's discretion, which is its own onboarding records and never the grantor's brand.json.

### R5. First contact and principal binding (P4, `L2/accounts-and-agents.mdx`)

These are the four binding rules from gate 2 of `specs/wba-profile-readiness.md` (on the [#7942](https://github.com/adcontextprotocol/adcp/pull/7942) branch), with the rule 1 rewording from [#7942 comment 6087434878](https://github.com/adcontextprotocol/adcp/pull/7942#issuecomment-6087434878):

1. **Verification alone never creates a principal.** A verified origin with no binding is *identity-established*: it gets what an anonymous caller gets, reads included, plus `get_principal` (R8). A principal comes only from a binding under rule 2, including the binding a seller creates when it approves a new identity.
2. A binding is an explicit, audited seller record from origin to principal, made only after R3a succeeds.
3. An origin maps to at most one principal.
4. A seller binds onto an existing 3.2 `agents[].url` principal only when the origin is unambiguous, and only with explicit out-of-band seller approval. In 3.2, controlling the agent's host was not enough to obtain its keys; this rule keeps origin control alone from inheriting an existing principal. This binding is never automatic.

**Automatic binding.** Where the seller declares an `open` mode (R7), `sync_principal` from an identity-established caller MAY create a **new** principal, limited to the open modes. `get_principal` never creates one. Anything else waits for seller approval.

### R6. Authority: grants (P5)

Specified in [#8157](https://github.com/adcontextprotocol/adcp/pull/8157), together with its decision record, DR-0025 (#6033). R7 relies on it for the `grant` requirement kind.

### R7. Onboarding posture (P6, `get_adcp_capabilities.mdx`)

Shape (experimental feature `account.agent_onboarding`):

```json
{
  "account": {
    "supported_billing": ["operator", "agent"],
    "sandbox": true,
    "agent_onboarding": {
      "sandbox": { "mode": "open", "url": "https://streamhaus.example/sandbox" },
      "billing": {
        "operator": { "mode": "open", "requirements": [{ "kind": "grant" }] },
        "agent": {
          "mode": "application",
          "url": "https://streamhaus.example/partners/agent-billing",
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
- `billing` is keyed by `enums/billing-party.json` values (`operator`, `agent`, `advertiser`), and its keys MUST be a subset of `supported_billing`. `sandbox` is valid only when `account.sandbox` is true.
- Each mode MAY carry its own `url`, which defaults to the top-level `url`.
- Modes: `open`, `application`, `invite_only`. An absent key means undeclared, not `invite_only`.
- Requirement kinds are closed, `x-extensible`, and each kind states the direction it applies to:
  - seller gating a buyer: `agent_identity` (a trust record entry with the required role), `grant` (R6), `billing_entity`, `contract`, `credit_application`;
  - buyer gating a seller (#8114): `aao_verified` and `storyboard` (seller badges and storyboards exist today), `sandbox`, `experimental_feature`;
  - a kind used in the wrong direction is ignored;
  - an unknown kind falls back to `message` and `url`.

**Ships on its own.** `application`, `invite_only`, and every requirement kind except `grant` work on the 3.2 profile with existing credentials. Only `open` and the `grant` kind depend on P2–P5. A seller cannot declare `open` until a first-contact mechanism exists.

**What `open` means.** `open` requires an identity established from the agent's published keys (R3). A seller that only maps opaque, seller-issued credentials cannot declare it. `open` binds identity, not spend. Under any `open` mode:
- the `grant` requirement is satisfied by R6, including the implicit case when the operator is the brand;
- when the account's brand is outside the buyer's operator domain and no grant covers it, the request is denied;
- spend-committing operations need an existing seller-side billing relationship with the billed party: the operator domain under `operator`, or the brand's domain under `advertiser`;
- quotas and rate limits for automatic binding are counted per operator domain, not per origin;
- an origin whose registrable domain comes from the PSL PRIVATE section, such as a tenant subdomain of a hosting platform, is eligible for `sandbox` only.

**Uniformity.** The block is seller-wide, identical for every caller, served on the unauthenticated fetch, and absent from error payloads. The oracle clamps in `error-handling.mdx` are unchanged.

**Buyer posture (#8114)** goes in `agents[].profiles.adcp.onboarding` in the buyer's trust record, with record-level `record_profiles.adcp` as an optional default. Its modes are distinct from the seller's: `considers_unsolicited`, `application`, `invite_only`. An agent that serves `get_adcp_capabilities` is authoritative there.

### R8. Relationship status (P4, `get_principal.mdx`)

- `get_principal` adds `relationship: { status, expires_at, setup }` on the `unconfigured`, `recognized`, and `current` results.
- `relationship` is **omitted** when the seller has no relationship with the caller and no application in progress (the identity-established state of R5 rule 1).
- Status values, when present:
  - `pending`: an application or approval is in progress;
  - `active`;
  - `suspended`;
  - `blocked`.
- While `pending`, an optional `setup { url, message, expires_at }` carries an applicant-specific next step, in the same shape as `sync_accounts` `setup`.
- It is returned only to the authenticated caller. P4 opens the closed `unconfigured` schema (`get-principal-response.json`) for this one field.
- `principal.changed` adds the reasons `relationship_changed` and `relationship_expiring`. The second fires at a seller-declared lead time before `expires_at`, following `setup_expiring`.

### R9. Revocation and committed work (P3)

Applies to both signing profiles. The revocation list stays as it is (signed by its issuer, with `updated`, `next_update`, and `revoked_kids`), and borrows the per-entry detail X.509 already defines for this case.

1. **Revocation stops new verification.** From the moment a verifier's view of a revocation list includes a key, every request signed with that key is rejected, whatever its `created` time. This restates what `revoked_kids` already means for verification.
2. **Committed work stands.** A media buy the seller accepted while the key verified stays in force. A seller MUST NOT pause, cancel, or otherwise unwind a buy on revocation alone. Under WBA a compromised origin could otherwise publish revocations to stop a buyer's campaigns.
3. **Revocation details follow RFC 5280.** A list MAY carry `revocation_details`, an object keyed by `kid`, for keys that appear in `revoked_kids`. Each entry MAY carry:
   - `reason`: a reason code from RFC 5280 §5.3.1, as RFC 8555 §7.6 writes them in JSON, such as `keyCompromise`, `superseded`, or `cessationOfOperation`;
   - `invalidity_date`: the date on which the private key is known or suspected to have been compromised (RFC 5280 §5.3.2). It may be earlier than the revocation.

   Verification is unchanged: a revoked key is rejected whatever its detail. As in X.509, an entry is not withdrawn or weakened once published, and verifiers keep the most severe detail they have seen for a key (a `keyCompromise` entry, and the earliest `invalidity_date`). A signer that revoked a key by mistake publishes a new key.
4. **Exposure.** A request verified under a key revoked with `reason: keyCompromise` is suspect if the seller **received** it at or after the `invalidity_date`, or at any time when there is no date. The comparison uses the seller's receipt time, never the signature's `created`, which the signer controls. A key revoked for any other reason, or with no detail, exposes nothing.
5. **The seller SHOULD show the buyer the buys it accepted under suspect requests,** by a means of its choice. The buyer resolves each with the existing `control_media_buy` actions (`paused`, `canceled`), signed with a current key; disputes go through the commercial relationship. A standard signal for this, and a bulk resolution path, are a separate proposal: #8158.
6. **Governed buys** keep today's rule: a revoked governance key stops new delivery-phase tokens until the governance agent issues a fresh one.

The window of exposure is the time between compromise and the revocation reaching the seller. The revocation freshness ceiling bounds it, and so does the recommended spend ceiling in the production security profile (#7066).

## Threat model deltas

| Threat | Control |
|---|---|
| Header names a victim's origin | The signature must verify under that origin's directory key (WBA §4.1, §5.4). |
| Stripping header coverage to force the 3.2 profile | A present `Signature-Agent` or `web-bot-auth` tag means WBA only; an uncovered member is not attributed (WBA §5.2.2). |
| Attacker lists a victim origin in the attacker's own trust record | Only the record at the origin's registrable domain counts (R3a). |
| Request signature replayed as a webhook, or the reverse | Covered `@authority` and `@target-uri` plus the nonce (R2). |
| Subdomain takeover (dangling CNAME) of a listed origin | The same exposure 3.2 has when the host behind `jwks_uri` is taken over. Detect and respond: sellers SHOULD alarm when a bound identity's key set changes, and the operator delists the origin, which revokes within one cache lifetime (R3a, freshness). The origin inherits its operator's grants unless they narrow with `agents[]` (R6). Operator guidance (P8): list only origins whose DNS you control, and remove DNS records for retired agents. Preventive detection comes with key transparency logs in 3.4. No key pin in trust.json: a second, hand-maintained key list breaks WBA rotation (a new key is published alongside the old one) and contradicts D3. |
| Compromised origin serves an empty revocation list | Verifiers retain seen revocations; the operator delists (R3a, freshness). |
| Compromised origin publishes revocations to stop a buyer's live campaigns | Committed work stands; revocation only flags buys for buyer review (R9). |
| Attacker backdates `created` to land before the invalidity date | Exposure uses the seller's receipt time, not the signer's `created` (R9). |
| Attacker controlling the origin weakens a published compromise entry | Entries are not withdrawn or weakened once published; verifiers keep the most severe detail they have seen for a key (R9). |
| Origin control used to take over a 3.2 principal | Binding onto a 3.2 principal needs out-of-band seller approval (R5 rule 4). |
| Downgrade to a stale 3.2 key | No downgrade after binding; before binding, the operator removes the 3.2 keys from brand.json (R4). |
| Stale brand.json grants override trust.json | A 200 from trust.json disables `authorized_operators[]` (R4). |
| Anonymous party opens billed accounts | `open` binds identity only. Spend needs an existing billing relationship, and an out-of-domain brand needs a grant whose chain includes `account.operator` (R6, R7). |
| Free registrable domains on hosting platforms defeat quotas | PRIVATE-section domains are `sandbox` only; quotas per operator domain (R7). |
| Trust-record fetches used as an amplifier or network probe | Evaluated only at gates, never on the signature path. One hop, fetch limits, and one external authorization code (R3a). |
| Signature errors used to probe which check failed | WBA status and headers only; no signature-specific body detail (R2). |
| Posture used as an onboarding oracle | Seller-wide, unauthenticated, uniform block. Per-agent state only in authenticated `get_principal` (R7, R8). |
| PSL drift between verifiers | Pinned, dated snapshot, as `security.mdx` already requires. |

## Known risks

| Risk | Position |
|---|---|
| **Draft maturity.** WBA is an adopted IETF draft (-00). | Experimental and capability-advertised; the draft revision is advertised (R2); the 3.2 profile keeps working through 3.x. |
| **Edge verifiers.** Deployed CDN verifiers lag the draft. | Sellers verify at their origin with the SDKs (WBA Appendix C.10). The interop matrix is tracked separately. |
| **One agent per origin.** Path-hosted agents must move to subdomains. Multi-tenant sales platforms whose path-based URLs appear in many publishers' `adagents.json` files cannot move without those files changing. | The problem being solved is buyer to seller, and buyers can add subdomains cheaply. Path-hosted sellers keep 3.2 webhook signing until they migrate. |
| **Directory upkeep.** Signed directory responses expire, so publishing keys is a scheduled job. | SDK CLIs provide a regenerate command; the walkthrough (P8) shows a scheduled job. |
| **Document signing.** Governance and rights JWS need key-purpose isolation and historical provenance. | Deferred to 3.4 (Scope of 3.3, above). |

## Compatibility and migration

- **Additive in 3.3.** The WBA profile, trust-record evaluation, grants, posture, and relationship status are experimental and capability-advertised.
- **One breaking change to an experimental surface:** the trust.json v1 edits in D3. They must merge before 3.3 beta.0.
- **One deprecation:** the 3.2 profile, with the 6-month notice `versioning.mdx` requires. It is not removed in 3.x.
- **Buyers** may publish a directory and trust record now. A seller that does not advertise the WBA profile keeps verifying 3.2 signatures.
- **Sellers** advertise the WBA profile per operation, as with `request_signing` today.
- **Agencies hosting several agents on one origin** move each agent to its own subdomain before adopting the profile.
- **4.0** removes the 3.2 profile, the brand.json trust fields, and `identity.brand_json_url`.

## Plan

| PR | Scope | Changeset |
|---|---|---|
| **P0** | This spec and DR-0023 | none |
| **P1** | trust.json v1 edits:<br>- remove `agents[].jwks_uri`, its default, and the back-pointer text;<br>- one agent per origin, and agent URLs anywhere in the record match by canonical origin;<br>- the canonical-origin definition in `url-canonicalization.mdx` (R0), with vectors;<br>- the validator, using the SDK's canonicalization;<br>- examples moved to one origin per agent. | minor |
| **P2** | WBA signing profile: #7894 rebased onto P1 by its author (R1, R2), with revocation at the origin and capability advertisement | minor |
| **P3** | Identity verification (R3), trust-record evaluation (R3a), coexistence and the 3.2 deprecation notice (R4), and revocation semantics with RFC 5280 reason codes and invalidity dates (R9) in `security.mdx`; reverse "nothing consumes this in 3.3" in the trust.json schema, `trust-json.mdx`, `experimental-status.mdx`, and release-docs #8074 | minor |
| **P4** | First contact and binding (R5); relationship status (R8), including the `get-principal-response.json` and `principal-changed-webhook.json` changes | minor |
| **P5** | Grants (R6, #6033) | minor |
| **P6** | Onboarding posture (R7, #8113), including the `profiles.adcp.onboarding` slot for the buyer posture (#8114). Lands independently; only `open` and `grant` wait for P2–P5. | minor |
| **P7** | Conformance:<br>- dual-source storyboards;<br>- trust-record, grant-chain, downgrade, and WBA vectors;<br>- an end-to-end self-onboarding storyboard;<br>- the training agent verifies WBA, serves its own directory and trust record, and opens the sandbox mode. | minor |
| **P8** | Docs:<br>- an "A buyer agent onboards itself" walkthrough, which sets the TL;DR expectation for `open`;<br>- rewrites of `request-signing.mdx` and `brand-protocol/seller-setup.mdx`;<br>- updates to `brand-json.mdx`, `trust.mdx`, `security-model.mdx`, `L2/authentication.mdx`, operating guides, learning tracks, glossary, and `known-limitations.mdx` (D10);<br>- the OAuth/auth.md mapping (D11). | patch |
| **P9** | Migration guide `docs/reference/migration/agent-identity-3-3.mdx`, by role (buyer signer, seller verifier, agency or operator, SaaS platform, governance agent), with an SDK version table, the 3.2 deprecation, and rollback; entries in `3-2-to-3-3.mdx`, `whats-new-in-3-3.mdx`, and release notes | patch |
| R1 (follow-on) | Registry crawl of trust records and posture; requirement-match filter | — |

### SDK workstream

| Change | JS | Python | Go |
|---|---|---|---|
| Accept extra covered headers (ship first) | — | — | S |
| WBA signer: `Signature-Agent`, nonce, thumbprint `kid` (opt-in); CLI to generate and re-sign the key directory | S | S | S |
| WBA verifier with a resolver for many signers, keyed by the header | M | M (fixes adcp-client-python#1214) | S–M |
| Trust-record evaluation at binding and grants; 3.2 profile kept with a deprecation warning | M | M | M–L |
| Grant verification, posture and relationship types | S–M | S–M | S–M |
| Hook for identity-established signers | S–M | S–M | S–M |

Tracking: adcp-client#3098, adcp-client-python#1283, adcp-go#548 and #109. Each SDK publishes a migration note linked from P9.

## Resolved questions

1. **Revocation path.** One list per origin, at the existing `/.well-known/governance-revocations.json` path and `adcp-gov-revocation+jws` type, covering all of the identity's keys (#7878 §Revocation).
2. **Lead time for `relationship_expiring`.** Seller-declared, following `setup_expiring`. A protocol minimum can wait for adoption data.
3. **`authoritative_location` binding.** None added. The operator is derived from `O` and the match is on `O`, so a shared hosted document cannot make one domain's agents another's. `brand-identity-trust-split.md` §Hosting covers grants.

## Appendix: 3.4 direction for JWS surfaces (non-normative)

Recorded so the 3.4 work starts from the reviewed design. Nothing here applies in 3.3.

- For a JWS (governance context, designated-task response signing, rights attestations), `O` would be the canonical origin of `iss`, or of `agent_url` where the surface uses it. The verifier would use the WBA path when the trust record derived from `O` lists `O`, and profile selection would never read an unsigned field.
- A role in the agent's own record is the operator's claim about itself. On these surfaces the relying party would also consent:

| Surface | Relying-party record | Required |
|---|---|---|
| Governance context `iss` | the buyer's | the buyer's operator is `eTLD+1(host(O))`, or holds a grant to it with `adcp:governance` |
| Designated-task response signing | the brand's | the brand's operator is `eTLD+1(host(O))`, or holds a grant to it with `adcp:brand_identity` |
| Rights attestations | the rights holder's | the rights holder's operator is `eTLD+1(host(O))`, or holds a grant to it with `adcp:rights_clearance` |

- Historical verification needs a provenance contract: the existing governance key archive until transparency logs are required.
