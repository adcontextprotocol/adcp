# Production security profile (3.3)

**Status**: Draft for working-group review
**Issue**: #7066 (primary). Inputs: #6105, #7817, #7878, #6033, #2307, #2324, #5669
**Normative text**: `docs/building/by-layer/L1/production-security-profile.mdx`
**Wire**: optional `security_profiles` on `get_adcp_capabilities`

This document is the design record: threat model, requirement table, capability representation, downgrade rules, and the decisions the working group still has to make. The docs page carries only the normative text for the 3.3 slice.

## Cycle constraints

3.3 is additive-only and has a short cycle. A requirement that needs a new MUST on every 3.x implementation, or a wire break, goes to 4.0. Anything that does not fit goes to 3.4. The 4.0 section below stays empty until #2307 closes, because #2307 is an input to it and not a co-author.

## Threat model

**Assets.** Spend commitments (`create_media_buy` and the other operations in the closed list), account data, governance bindings, and the counterparty's trust in an advertised posture.

**Actors and threats.**

| # | Threat | Control |
|---|---|---|
| T1 | A stolen signing key used before anyone notices | P3 revocation freshness, P6 ceiling, instant suspend |
| T2 | A valid, unrevoked key whose agent was manipulated (prompt injection through a counterparty's response) | P6 ceiling, deterministic spend authorization, context fencing |
| T3 | A seller that advertises the profile and still accepts unsigned spend | P1, P2, the downgrade rules, and eventually registry verification |
| T4 | A buyer silently falling back to bearer when the profile disappears | Downgrade rules D1 and D2 |
| T5 | A stolen key that binds the attacker's own governance agent | P5 |
| T6 | A relay or intermediary that claims authority for a party upstream of it | P4 single-hop, non-transitive |
| T7 | A rolled-back or cached revocation list that un-revokes a key | P3 monotonic `updated`, accumulate-only |
| T8 | Server-side request forgery through buyer-supplied URLs | P8 |
| T9 | Attacker-controlled free text in a well-formed tool response steering an LLM | Context fencing (practice) |

**Excluded.** A compromised seller. Compromise of the signer's own origin (an attacker who controls `/.well-known` can serve forged keys and a forged revocation list; the remedy is the key-transparency work in #7878 and 4.0). TEE and pinhole boundaries. Payment fraud outside the protocol. Publisher pins do not defend against a stolen **buyer** key: they narrow keys for sell-side signatures about a publisher's inventory only. The triage memo listed pin preference as a mechanism for a compromised buyer, and it is not one, so the profile does not claim it.

**Review gates.** Two, per the security review: the threat model above is reviewed before the requirement table is treated as candidate text, and the implementation language is reviewed before the profile graduates. The first ran on this draft and its findings are folded in.

## Requirement table

**Tag** is the strongest status a requirement can reach. `3.3-additive-declaration`: an endpoint can commit to it in 3.3 using optional fields and an optional profile, and no other endpoint is affected. `4.0-mandatory`: it needs a new MUST on every implementation or a wire change, so it is stated for 4.0 only.

**Verifiability.** `declared`: visible in capabilities. `storyboard`: gradable by a conformance storyboard (follow-up; until it exists the claim is self-asserted). `attested`: cannot be graded from outside the endpoint, so it is a practice and is **not** covered by the profile id. This split keeps the id from reading as a safety certificate for things nobody can check.

| ID | Source | Requirement | Tag | Verifiability | In the id |
|---|---|---|---|---|---|
| R1 | Req 1 | RFC 9421 signing with body integrity and replay protection for spend-committing operations | 4.0-mandatory (universal). 3.3 form: A1, A2, P1, P2 through existing `required_for` | declared, storyboard | yes |
| R2a | Req 2 | Published revocation behavior and a freshness bound | 3.3-additive-declaration | storyboard | yes (P3) |
| R2b | Req 2 | Short-lived credentials and rotation | 3.3-additive-declaration | attested | no |
| R3 | Req 3 | Least-privilege grants and explicit acts-for authority | 3.3-additive-declaration (seller onboarding record and `authorized_operators[]`; operator-published grants are #6033, milestone 3.4) | storyboard | yes (P4, P7) |
| R4a | Req 4 | SSRF-safe fetch of buyer-supplied URLs | 3.3-additive-declaration | storyboard | yes (P8) |
| R4b | Req 4 | Principal-bound, allowlisted retrieval of assets and artifacts | 4.0-mandatory (normative home is #5669, milestone 4.0) | storyboard | no |
| R5 | Req 5 | Bounded idempotency and safe retry for every mutation | 3.3-additive-declaration | declared | yes (A4) |
| R6 | Req 6 | Audit retention and correlation | 3.3-additive-declaration | attested | no |
| R7 | Req 7 | Anomaly and rate limits for probing, hold squatting, spend changes | 4.0-mandatory (normative enforcement) | attested | no. P6 is the testable slice. |
| R8a | Req 8 | Governance gates for consequential operations, above a threshold | 3.3-additive-declaration | attested | no |
| R8b | Req 8 | Governance-agent binding cannot be changed by a signing key alone | 3.3-additive-declaration | storyboard | yes (P5) |
| R9 | Req 9 | Webhook signing, sequence repair, stale-key recovery | 3.3-additive-declaration | declared | yes (A5) |
| E1 | Security review | Fence attacker-controlled content from counterparty tool responses before it reaches an LLM | 3.3-additive-declaration | attested | no |
| E2 | Security review | Revocation propagation with a ceiling | 3.3-additive-declaration | storyboard | yes (P3) |
| E3 | Protocol review | Spend ceiling as a circuit breaker | 3.3-additive-declaration | storyboard | yes (P6) |
| E4 | Protocol review | Hard-refuse downgrade | 3.3-additive-declaration | storyboard (buyer side) | yes (D1, D2) |
| E5 | Protocol review, #2324 | Acts-for validated across relay hops | single-hop: 3.3-additive-declaration. Multi-hop chains: 4.0-mandatory | storyboard | yes (P4) |

Departures from the triage memo, all in the conservative direction. R4 is split because its normative contract is #5669, which is a 4.0 item. R1 is `4.0-mandatory` as a universal floor but is reachable in 3.3 through fields that already exist. "Per-session" spend ceiling became a per-principal ceiling, because DR-0022 (proposed) says an MCP session carries no authority, so a session-keyed ceiling would reset on reconnect.

## Capability representation

```json
{
  "security_profiles": ["adcp-prod-security-3.3"]
}
```

- **Where.** The `get_adcp_capabilities` response, as a top-level optional array of ids. The triage memo proposed `adagents.json`. That file is the publisher's attestation of who may sell its inventory. It cannot describe an agent that is not a publisher, and it is not where `request_signing`, `identity`, or `webhook_signing` live or where the harness already probes. A publisher-side requirement that its authorized agents hold the profile can reference the id later (deferred).
- **Type.** An open string with a pattern, not a closed enum. A closed enum would make a 3.3 response fail validation in a strict 3.2 client. Consumers ignore ids they do not recognize and never count one as satisfying a requirement. Producers use only ids the profile page registers.
- **Immutable ids.** New semantics, including a new member of the spend-committing list, ship under a new id. This is what makes an experimental label unnecessary: a profile can change by being superseded.
- **Scope.** Verifying endpoints only. A buyer-only agent has no capabilities response and advertises nothing. It is judged by what a profile seller can verify on each request.
- **Admission.** The six preconditions in the docs page all use existing optional fields. Advertising while one is false is a conformance failure.

## Asymmetric enforcement

A profile seller rejects what it can verify (unsigned, invalid, revoked, stale, unmapped, over ceiling). It cannot enforce a counterparty's internal practices, so the profile does not pretend to. The advertisement binds the advertiser. It constrains counterparties only through the seller's own checks. This also makes migration market-driven without breaking 3.x compatibility: a buyer that wants to trade spend with profile sellers signs, publishes a revocation list, and gets onboarded.

The rule has teeth only if "no unsigned fallback" holds endpoint-wide. A seller with a mixed base of signing and bearer-only buyers serves them from separate endpoints.

## Compromised but validly signed buyer

The triage memo named four mechanisms. After review:

1. **Revocation freshness.** Kept (P3). Hard staleness cutoff with no grace multiplier, polling at T/3, monotonic list.
2. **Spend-velocity ceiling.** Kept and sharpened (P6): per principal (the seller's mapping of the canonical identity) across accounts, deny by default (`PERMISSION_DENIED` when unset), `AGENT_SUSPENDED` on trip so an agent does not retry a halt, and reductions or cancellations never blocked so a tripped agent can stop its own spend. It is the only control that bounds loss from a hijacked agent whose key is intact. Its cost falls on agencies whose one agent spans many advertisers, so decision 6 asks the WG to confirm it belongs in the id.
3. **Acts-for dual binding.** Restated. The primitive is the governance token's amount, task, and payload-hash binding, not DR-0018, which only constrains which governance agents a seller accepts at `sync_governance` (that is P5). The token requirement above a threshold is a practice.
4. **Publisher key pinning.** Dropped from this section, as above.

## Decisions for the working group

1. **Profile type.** Named capability profile, or an AgenticAdvertising.org verification prerequisite. *Recommend: named profile.* A prerequisite has no wire shape, makes the org a gatekeeper, and cannot be tested independently. Registry verification of the claim can layer on later.
2. **Asymmetric enforcement.** Must a seller advertising the profile reject non-conforming counterparties on spend-committing operations? *Recommend: yes,* limited to what it can verify. Advertising without enforcing is the false safety the profile exists to remove.
3. **Ship in 3.3 or publish an advisory and accelerate 4.0.** *Recommend: ship the 3.3 profile.* A bounded slice exists: one optional field, one docs page, no new error codes, and every requirement uses a field or code that already exists. The risk is a voluntary-profile trap, where operators wait for the mandatory 4.0 floor. The market pull from sellers that require it is the answer to that, and the advisory path would spend the same effort on text nobody can claim.
4. **Revocation ceiling for spend-committing calls.** 5, 15, or 30 minutes. *Recommend: 15.* It is 10× tighter than the roughly 150-minute worst case of the 3.2 baseline, it matches the repo's existing 15-minute figures (the intent-token cap and the guidance for tokens above a material threshold), and with polling at T/3 it tolerates one failed fetch before the profile halts spend. At 5 minutes a short outage of a signer's origin halts all of that signer's spend. At 30 the only gain over today is dropping the grace multiplier, and propagation to the verifier stays at today's polling ceiling. #6033's 30-minute cap on grant caches stays as the maintainer decided; the profile is stricter for spend only.
5. **Binding to the WBA decision (#7878).** *Recommend: stay signing-profile-agnostic.* The profile is defined over four properties of a signed request (body digest, unique nonce, one canonical identity per key, revocation-checkable) that any advertised signing profile can meet. That removes any ordering dependency between this profile and #7878.

6. **Is the spend ceiling part of the id?** Or a SHOULD-level practice like the other controls that cannot be graded from outside. *Recommend: in the id.* It is the only control that bounds loss from a manipulated agent with a valid key, and its existence (a configured value, deny by default) can be graded with the test controller in the follow-up storyboard. The cost is that every seller must configure a ceiling per onboarded principal before it can advertise.

## Deferred

- **4.0 section.** Reserved. R1 as a universal floor, R4b, R7, and multi-hop chains are written after #2307 closes.
- **Storyboards and SDK helpers.** Seller and buyer storyboards for P1 to P8 and the downgrade rules, plus SDK helpers for key storage, rotation, and verification, are follow-up PRs. The requirement set has to be stable first, so they wait for decisions 1 to 5.
- **Registry verification** of the claim.
- **Publisher-side requirement** that authorized agents hold the profile.
- **Multi-hop signature chains** (#7878 decision 6).
- **External security review** before the profile graduates from proposed to registered.

## 4.0

Reserved. Not drafted until #2307 closes.

## Review record

Reviewed twice by the protocol, product, and security reviewers. Round two added: P2 cites the Strict posture and rejects the per-caller flag branch; P4 limited to the onboarding record and `authorized_operators[]` and must agree with the bearer-selected principal; P5 requires non-empty enforced criteria; the ceiling counts increases only and states its code for the unset case; revocation lists with a future `updated` rejected; the downgrade store defined for failed fetches and URL changes; the client-only path pins the full `jwks_uri` and requires it to be explicit; #7820 recorded as a dependency for A2A. Round one forced: scope narrowed to verifying endpoints; the id covers only gradable requirements; the spend-committing list made explicit and closed; acts-for rewritten on governance-token primitives; the velocity ceiling made deny-by-default and keyed by canonical identity; revocation freshness redefined as verifier-measured with T/3 polling, so it does not constrain signers; error codes pinned per case; the downgrade rule given a per-principal store and an operator reset; `security_profiles` made an open string.
