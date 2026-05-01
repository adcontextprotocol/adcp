---
---

docs(security): synchronous RPC response bodies are not signed — by design (#3737)

Resolves the open RFC question about whether AdCP intends to sign outbound
RPC response bodies. **Decision: out of scope for 3.x — and not as a
coverage gap, but as the intended two-surface design.**

The synchronous reply is consumed inside the authenticated session that
carried the request; the buyer already holds TLS-bound proof that the
seller it authenticated to answered. A signature on that body adds no
information the session doesn't already carry. At-rest integrity for
durable artifacts is the job of signed webhooks, where the artifact
verifies against keys long after the TCP connection has closed.

Webhook-only attestation is a forcing function: it makes "this artifact
needs durable integrity" an explicit modeling decision rather than a free
rider on every reply. Adding a fourth `adcp_use` purpose for response
signing would impose JWKS, rotation, verifier, grader, and revocation
cost on every adopter for a benefit that already has a cleaner path
through webhooks.

**Normative line (added):** Buyers MUST NOT rely on response-body
signatures; integrity for synchronous replies is delivered by TLS, and
artifacts requiring at-rest attestation MUST be delivered via signed
webhooks. Sellers MUST NOT sign synchronous AdCP response bodies under
any `adcp_use` value.

**The request-the-webhook pattern (added).** Tools whose canonical
artifact needs to be attestable should restructure to emit a signed
webhook carrying the canonical version, with the synchronous reply as
transport-only acknowledgement. Verification is uniform with every
other at-rest seller→buyer message — no new specialism, no new grader.

**Doc updates.**

- `docs/building/understanding/security-model.mdx` — new "What gets
  signed — and what doesn't" subsection after Layer 5. Enumerates the
  three application-layer signing surfaces (request, webhook,
  governance), carries the normative MUST NOT, presents the
  deliberate-split rationale (TLS-scoped sync + signed-webhook async,
  forcing-function for sellers, operational cost of doubling the
  signing surface), addresses two near-cases that aren't response
  signing (audit/forensics on tool replies; cross-agent forwarding
  via specialism-scoped surfaces like brand-rights), and ends with the
  request-the-webhook pattern. Updated the "What AdCP does not do in
  3.0" prose summary to point at the new subsection.
- `docs/reference/known-limitations.mdx` — paired entry under Security
  and privacy with the same framing.
- `docs/building/implementation/security.mdx` — added a "No symmetric
  response-signing profile" callout under Signed Requests carrying the
  normative MUST NOT, so the rule lands in the canonical
  implementation reference and not only in the model doc.

**SDK implication (informative, no SDK change in this PR).** The
decision keeps `TenantConfig.signingKey` as the long-term name in
`@adcp/sdk` (no rename to `webhookSigningKey`). The auto-wire's strict
`adcp_use: "webhook-signing"` enforcement makes the current binding
explicit at the JWK layer; if 4.0 introduces additional outbound
signing surfaces (cross-protocol attestations, governance receipts,
etc.), the same field extends gracefully without a breaking rename.

Decision is revisitable at 4.0 if the threat model evolves
(e.g., a transport pattern emerges where a synchronous reply carries
durable state that does not also flow through a webhook).

Closes #3737.
