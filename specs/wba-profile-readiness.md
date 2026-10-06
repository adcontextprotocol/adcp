# Web Bot Auth profile: readiness gates for #7878

**Status**: Draft for working-group review
**Issue**: #7878. Illustration: #7894 (not duplicated here). Related: #7817, #7882, #7819
**Purpose**: close the four gaps maintainers named on #7878, so the working group can decide the profile on evidence. This document writes down what the profile needs. It does not change #7894.

The four gates are a deployed-verifier interop matrix, an identity migration from a WBA origin to the existing `agents[].url` principal, an enforceable key-purpose binding, and a provenance contract for historical key evidence. Each section ends with what is still open.

## 1. Deployed-verifier interop matrix

#7894 specifies `Signature-Agent` as an RFC 8941 dictionary member (`sig1="https://buyer.example"`), Ed25519 only, a `nonce` on every request, and seller-origin replay enforcement. The matrix records what deployed verifiers do with that. "Not published" means the vendor documentation retrieved for this review does not say, and the cell has not been tested.

| Verifier or library | `Signature-Agent` as dictionary | Nonce replay enforced | Algorithms | Draft revision | Evidence |
|---|---|---|---|---|---|
| Cloudflare bot verification | **Rejected.** Plain string only (`"https://signature-agent.test"`) | **No.** "There is currently no `nonce` validation" | Ed25519 only | `directory-03`, `web-bot-auth-architecture-02` | [Vendor documentation](https://developers.cloudflare.com/bots/reference/bot-verification/web-bot-auth/), retrieved 2026-10-06 |
| AWS WAF (CloudFront only) | Not published | Not published | Not published | "Two active IETF drafts" | Launch announcement; parameters not given |
| Vercel bot verification | Not published | Not published | Not published | Not published | Changelog; parameters not given |
| Akamai | Not published | Not published | Not published | Not published | Announcement only |
| `web-bot-auth` (Cloudflare library) | Single-signer request verifies | Not stated | Ed25519 (the vectors' algorithm) | Not stated | Reported in the #7894 description; not re-run here |
| `http-message-sig` (generic RFC 9421) | All positive vectors verify, including relay | Not stated | Ed25519 (the vectors' algorithm) | RFC 9421 only | Reported in the #7894 description; not re-run here |

**What this means for the profile.**

1. A Cloudflare edge verifier that sits in front of an AdCP seller and has bot verification enabled rejects requests that carry the profile's dictionary form. Until Cloudflare accepts the dictionary form, a seller on that edge verifies at its origin and the edge passes traffic through. Appendix C.10 of the WBA draft covers the pass-through case, and #7894 already says the origin enforces nonces regardless of the edge.
2. Nonce replay stays the seller's job. Cloudflare documents no nonce enforcement, and the other rows are unknown, so #7894's rule that the seller's verifier enforces nonces is the only safe assumption.
3. The algorithm sets agree (Ed25519). This is a reason not to widen the profile to P-256 in 3.3.

**Open.** Three vendor rows are blank for lack of public parameters. Close them by sending the ten #7894 vectors through each verifier and recording status codes. The result replaces the "Not published" cells. A verifier that answers neither accept nor reject on a given vector is itself a finding. This is the evidence the WG needs before deprecating the current profile (question 2 on #7878).

## 2. Identity migration: origin to `agents[].url` principal

3.2.1 fixes the seller-local principal to the canonical `agents[].url`. Distinct URLs stay distinct even when they share a host or a JWKS. The WBA profile identifies a signer by origin. The migration must not let the second change the first.

**Rules.**

1. **A WBA identity never creates a principal.** A verified origin with no binding is `identity-established`: it gets what an anonymous caller gets, reads included.
2. **A binding is a seller-local, explicit, audited record:** `{principal, origin, bound_at, bound_by}`. It is created by an operator action or a seller policy the operator configured. It is never inferred from name similarity.
3. **One origin binds to at most one principal.** A principal may hold both its `agents[].url` binding and an origin binding. All principal state (accounts, grants, spend ceilings, suspensions) lives on the principal, so a suspension and a ceiling cover both profiles.
4. **Bind only when the origin is unambiguous.** The seller binds origin `O` to principal `P` only if the operator's brand record lists exactly one `agents[]` entry on origin `O`, and that entry's canonical URL is `P`'s. The seller re-checks this whenever it refreshes the record. If a second entry appears on `O`, the binding is suspended and the origin falls back to `identity-established` until an operator reviews it.

| Operator layout today | Eligible for the WBA profile | Migration |
|---|---|---|
| One agent alone on its host, or alone on its origin at a path | Yes | Bind the origin to the existing principal. Both profiles map to it during the transition. |
| Several agents on one origin at different paths | **No** | Stay on the current profile until each agent has its own origin, normally a subdomain. Rule 4 blocks the binding, so the agents are never merged. |
| Multi-tenant vendor, one host for all tenants | No until split | One subdomain per tenant. Each becomes its own principal and binding. |
| Agent moves to a new origin | Yes | Add a second binding to the same principal. Remove the old one after the transition. |

**Cost, stated honestly.** Agencies and platforms that run many agents on one host cannot use the WBA profile without moving to subdomains. That is acceptable only because the profile is optional and the current one stays. If the WG wants multi-agent origins in the profile, the origin alone cannot select a principal, because every key sits in one directory and a verifier cannot say which agent a newly published key belongs to. That would need a per-key binding at the seller. It is a different design, not a tweak.

**Open.** The mapping assumes the operator's brand record carries the agent list. #7819 moves that list to `trust.json`. The rule is the same, but the record name changes with it.

## 3. Enforceable key-purpose binding

The gap: a governance document must not verify under a transport key, and #7894 removes `adcp_use`.

**Mechanisms considered.**

| | Mechanism | Strength | Weakness |
|---|---|---|---|
| A | **Identity per purpose.** The governance agent is its own origin with its own directory. The verifier accepts a token only if its `iss` origin is listed in the governance role of a record the verifier already trusts. | Keeps the 3.2.1 rule that governance keys sit on a separate origin. A transport-origin compromise cannot mint governance keys. | Needs a role listing in the operator's record. |
| B | Keep `adcp_use` as an extra JWK member in the directory. | One field, one check. | Same origin, so a compromise of that origin publishes keys with any purpose. Restores the co-tenancy the current spec forbids. |
| C | Both. | Defense in depth. | Two mechanisms to keep consistent. |

**Recommendation: A.** The purpose is enforced by *who the issuer is*, not by a label on a key, so a verifier can check it from a record it already trusts.

**Verification that actually enforces it.** Checking that the key sits in the `iss` origin's directory is not enough. A transport origin that is also named in `iss` would pass that check. The binding comes from the last step: the verifier checks that the `iss` origin is listed in the governance role. Two negative vectors are needed for #7894's generator, each a governance JWS (`typ: adcp-gov+jws`) with an otherwise valid signature and claims:

| Vector | Setup | Expected result |
|---|---|---|
| `governance-token-signed-with-transport-key` | `iss` is the governance origin `G`. `kid` is the thumbprint of a key published only in transport identity `T`'s directory. | Rejected at the directory lookup: the key is not in `G`'s directory. |
| `governance-token-issued-as-transport-identity` | `iss` is `T`. `kid` is `T`'s own key, so the signature verifies and `jku` matches `T`'s directory. | Rejected at the role check: `T` is not listed in the governance role. This is the vector that proves purpose binding. |

**Open.** The role listing needs a home. Today it is the agent's `type` in `brand.json`. If #7819 moves it to `trust.json`, the vector's fixture follows.

## 4. Provenance and retention for historical key evidence

WBA Appendix B separates two facts. TLS shows the host served the response. The directory signature shows the key holder possessed the key. Neither shows that the domain published the key at a past time to anyone but the verifier that fetched it. The contract below defines what a verifier keeps and what an auditor may conclude from it.

**Evidence record**, one per directory or revocation-list fetch the verifier relied on:

- directory or list URL, retrieval time (verifier clock, with its time source), the verifier's identity and software version;
- the HTTP status and the headers that carry the proof: `Content-Digest`, `Signature`, `Signature-Input`, `Date`, `Cache-Control`;
- the exact response body bytes, and their SHA-256;
- the TLS facts at fetch time: server name, leaf certificate SHA-256, issuer, validity period, and the resolved address;
- a link from each request or document the verifier accepted to the record it relied on.

**Storage.** Append-only, with a hash chain over records so a later edit is detectable. Governance identities keep the record for the audit retention period (7 years is the current recommendation for governance keys). For transport identities, retention is operator-defined and at least the longest billing-dispute window the seller offers.

**What an auditor may conclude.** From a retained record: this verifier received these bytes from a host presenting this certificate at this time, and the key holder signed them. Not: that the domain's owner published the key on that date for anyone else to see. Where publication at a point in time must be shown, the evidence has to come from somewhere other than the verifier.

**Independent evidence.** Until transparency logs are required, governance identities keep the existing key archive (`jwks-archive.json`). Once logs are required, an inclusion proof under a witness-cosigned checkpoint replaces the archive as the proof of publication. Transport identities rely on the retained record and the revocation list.

**Open.** The retention period for transport identities, and the log format, are decisions for the transparency-log step (#7878 question 6), not this one.

## What the working group still decides

These feed the joint brief on #7878:

- **Gate 1.** Is the interop matrix complete enough, or is a seller-origin verification caveat enough for 3.3?
- **Gate 2.** Adopt the identity rules above, or specify a different mapping?
- **Gate 3.** Mechanism A, B, or C.
- **Gate 4.** The retention contract as written, with transport retention left to the operator.
