---
---

spec(security): name the key-discovery gap and specify the 3.x root-of-trust baseline

AdCP 3.0's identity, governance, and pointer-file layers all discover
the verifying public key from the counterparty's own infrastructure —
RFC 9421 buyer keys from the buyer agent's JWKS, governance JWS keys
from the governance agent's JWKS, agent signing keys from
`brand.json`, and pointer files from `/.well-known/adagents.json`.
Every one of those discovery paths trusts the counterparty origin as
the root of trust. TLS does not close this — the certificate is issued
to the hostname the attacker has compromised — so an attacker who
controls a counterparty's CDN, DNS, or `/.well-known` path can serve
attacker-controlled keys and signatures verify clean against those
keys.

The prior security model listed HMAC, RFC 9421, JWKS, and `brand.json`
attestation as individual mechanisms without ever naming the shared
assumption underneath them. That omission is the reason the R-3
pointer-swap threat, the agent-signing-key swap threat, and the
governance-JWKS-swap threat all feel like separate problems — they are
the same problem one layer deeper. Naming it is the 3.x precondition
for the 4.0 fix.

Adds two pieces:

- `security-model.mdx` — a new **Trust anchors and the key-discovery
  gap** section between *What AdCP does not do in 3.0* and *What is
  outside the protocol*. Enumerates where 3.0 relies on the
  counterparty origin (RFC 9421 JWKS, governance JWKS, `brand.json`
  agent keys, `authoritative_location` pointers), acknowledges that
  the existing AgenticAdvertising.org registry resolves identity and
  authorization and caches `adagents.json` `signing_keys[]` but does
  not today operate as a key-transparency anchor, specifies the
  TOFU-with-continuity baseline 3.x actually delivers, and documents
  four multi-source controls that raise the bar without transparency
  anchoring: DNS-TXT cross-check, publication-delay / continuity
  windows on never-before-seen keys, out-of-band key-rotation
  signalling, and rotation-validity discipline. Then sketches the 4.0
  extension — enrollment, append-only rotation log, public
  queryability, governance-neutral operation, JWKS wire compatibility
  — framed as adding key-transparency anchoring to the existing
  registry rather than building a new one, with the explicit caveat
  that it is not a 3.x requirement but is the anchor the 3.x controls
  are designed to feed into.

- `known-limitations.mdx` §Authentication and identity — adds a
  **No key-transparency anchoring in the registry** bullet that
  explicitly cites the existing registry and draws the line between
  identity/authorization discovery (shipped) and cryptographic key
  anchoring (4.0), and a cross-link to the new section, so the
  limitation is surfaced on the canonical non-goals page rather than
  only in the architectural discussion.

No schema change, no new wire format. The 3.x deliverable is honesty
about the trust model plus a normative baseline operators can actually
implement; the 4.0 deliverable is the registry itself, which is logged
as a successor track rather than hand-waved into 3.x.
