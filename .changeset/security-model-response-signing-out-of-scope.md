---
---

docs(security): document that synchronous RPC response bodies are not signed (#3737)

Resolves the open RFC question about whether AdCP intends to sign outbound
RPC response bodies. Decision: **(a) out of scope for 3.x.** TLS protects
the immediate reply for the duration of the connection; long-lived
integrity for asynchronous outcomes flows through signed webhooks
(`adcp_use: "webhook-signing"`) and the signed governance audit chain,
both of which are verifiable independently of the original transport.
Adding a fourth `adcp_use` purpose (response signing) would require a
paired verifier specialism and conformance grader for marginal additional
integrity, since the durable result already lands on a signed webhook.

Sellers that need body integrity on a result with no webhook follow-up
should deliver that result via a signed webhook rather than rely on the
synchronous reply.

**Doc updates.**

- `docs/building/understanding/security-model.mdx` — new "What gets
  signed — and what doesn't" subsection after Layer 5, enumerating the
  three application-layer signing surfaces (request, webhook, governance)
  and explicitly calling out synchronous response bodies as not signed.
  Updated the "What AdCP does not do in 3.0" prose summary to match.
- `docs/reference/known-limitations.mdx` — paired entry under Security
  and privacy, with the same framing and the upgrade path for sellers
  that need body integrity.

Decision logged for revisiting at 4.0 if the threat model evolves
(e.g., a transport pattern emerges where the synchronous reply carries
durable state that does not also flow through a webhook).

Closes #3737.
