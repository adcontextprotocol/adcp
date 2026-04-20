---
---

spec(webhooks): cross-endpoint replay-cache scoping is MUST, not implicit

The 9421 webhook verifier checklist dedups on `(keyid, nonce)`. The
application-layer dedup in `webhooks.mdx` dedups on
`(authenticated sender identity, idempotency_key)`. Both rules were
*per-cache*: a buyer that runs more than one webhook endpoint — per
integration, per environment, per tenant, or per pod in a
horizontally-scaled verifier fleet — can admit a cross-endpoint replay
inside the ±360 s signature-validity window if each endpoint holds its
own in-memory cache. Application-layer dedup has the same defect: a
duplicate event replayed to a sibling endpoint executes twice because
the second endpoint's cache has not seen the `idempotency_key`.

Adds two MUSTs:

- `security.mdx` **Webhook replay dedup sizing** — receivers that
  expose more than one endpoint MUST either share a single logical
  `(keyid, nonce)` replay cache across every endpoint or scope the key
  on `(keyid, canonical destination URL, nonce)`. Per-pod in-memory
  caches without a shared tier are non-conformant. Spells out which
  option is stronger and when option 2 is defeated (signer signs the
  same payload for multiple endpoints).

- `webhooks.mdx` **Idempotency** — receivers exposing more than one
  endpoint MUST share the `(sender identity, idempotency_key)`
  keyspace across endpoints, with a cross-link to the transport-layer
  companion rule.

No normative change at the single-endpoint-per-verifier case; closes
the cross-endpoint gap the prior wording left implicit.
