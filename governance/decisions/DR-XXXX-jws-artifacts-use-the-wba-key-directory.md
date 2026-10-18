---
id: DR-XXXX  # placeholder; next free number assigned at merge
title: In 3.3, a JWS artifact from a Web Bot Auth identity is signed with a key from that identity's key directory
class: normative
status: proposed
date: 2026-10-18
decided_by: pending WG ratification
refs: ["#8118", "#7878", "DR-0023", "PR #7894", "PR #8219"]
dissent: none recorded
---

## Decision

For AdCP 3.3, the three JWS artifacts (governance context `iss`, designated-task response signing, and rights attestations) move to the issuer's Web Bot Auth (WBA) key directory, as `specs/agent-identity-3-3.md` R4 states:

- **Which issuer.** `O` is the canonical origin of the signing agent's URL: `iss` for a governance context, `agent_url` for designated-task response signing, and `rights_agent.url` for a rights attestation.
- **When.** The trust record derived from `O` lists `O`. Profile selection never reads an unsigned field, and a fetch failure never selects the 3.2 profile.
- **How.** A key from `O`'s key directory, with `alg` `EdDSA` and `kid` the key's JWK thumbprint. Purpose separation is by origin, so the 3.2 key-purpose checks do not apply. Revocation is `O`'s list, and every other check of the surface is unchanged.
- **History.** Historical verification of a governance context uses the existing governance key archive at `O`. That is the governance-key provenance rule for 3.3.
- **Everyone else.** A JWS artifact from an issuer whose `O` no trust record lists is verified under the 3.2 profile, which stays fully functional through 3.x.

This amends DR-0023 in two rulings. The first is where JWS document signing goes: DR-0023's Scope ("JWS document signing moves in 3.4") and its list of what it does not settle ("JWS document signing and governance-key provenance (3.4)"). The second is where the trust record is evaluated: DR-0023's Decision ("never on the signature path") and its list of what it settles ("evaluated off the signature path") apply to the request-signature path only. The rest of DR-0023 stands.

## Rationale

A WBA identity already publishes one key directory and one revocation list at its origin. Signing its JWS artifacts with the same keys gives the issuer one place to publish keys and the verifier one place to find them, instead of a second chain through brand.json for the same agent until 3.4.

The 3.4 deferral waited for a provenance contract, because a retained directory response proves key possession, not publication at a point in time. The existing governance key archive has the same limit, and it is the provenance the 3.2 profile relies on today. Adopting it for the WBA path makes that path no weaker than 3.2. Proof of publication at a point in time is left to transparency logs.

The rule adds no infrastructure. It reuses the key directory, the trust-record derivation, the origin's revocation list, and the archive.

## Implications

**This record settles:**
- that the three JWS artifacts from a WBA identity use its key directory in 3.3;
- that governance-key provenance in 3.3 is the existing governance key archive;
- that a JWS artifact from an issuer no trust record lists stays on the 3.2 profile;
- that the trust record is derived on the JWS path to select the profile, and is still never evaluated on the request-signature path.

**This record does not settle:**
- transparency logs, which can replace or add to the archive in a later release;
- a relying-party consent table for these surfaces, which the earlier 3.4 direction proposed and this record does not adopt.
