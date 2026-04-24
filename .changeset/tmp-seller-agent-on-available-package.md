---
---

**TMP: explicit seller-agent attribution on AvailablePackage.**

Add `seller_agent: { agent_url, id? }` to the Trusted Match Protocol
AvailablePackage schema, making seller identity explicit on every
package cached by a TMP provider. The canonical identifier is the
seller's agent URL as declared in the property publisher's
`adagents.json` `authorized_agents[].url`; the reserved `id` slot is
forward-compatible with a future registry-assigned opaque identifier.

- **`/schemas/core/seller-agent-ref.json`** — new shared schema
  mirroring the `{agent_url, id?}` shape used by `format-id` and
  `ProviderEntry`.
- **`/schemas/tmp/available-package.json`** — `seller_agent` added as
  a required field. Lands as a patch under the experimental-surface
  contract (`experimental_features: trusted_match.core`, which allows
  breaking changes between 3.x releases with advance notice); sellers
  syncing `AvailablePackage` payloads need to populate it going
  forward.
- **`/schemas/tmp/offer.json`** — optional `seller_agent` echo so
  publisher-side log pipelines can attribute offers to sellers
  without round-tripping to the media-buy store. Non-authoritative:
  the cached package binding remains source of truth; routers MAY
  stamp the field on merge when providers omit it.
- **`/schemas/tmp/error.json`** — adds `seller_not_authorized` error
  code for sync-time rejection when `seller_agent.agent_url` is not
  present in the property publisher's adagents.json
  `authorized_agents[].url` list.
- **`docs/trusted-match/specification.mdx`** — new "Package Sync"
  section defines the sync contract, the SHOULD-level adagents.json
  validation flow, explicit per-actor responsibilities (seller
  agent, publisher, router, provider), and the "what this is not"
  boundary (not a request-time filter, not a sellers.json bridge,
  not a cryptographic attestation). Offer and Error tables updated
  accordingly; definitions table gains a **Seller agent** entry.

Seller identity lives on the cached `AvailablePackage`, not on
`context_match_request` or `identity_match_request`. Providers —
which have no access to a media-buy store — need provenance on the
wire they actually receive; putting it on the request would either
duplicate the sync-time binding or open a path for request-time
seller filtering that re-introduces the identity- and
allocation-leakage failure modes that package-set decorrelation
exists to prevent. Publishers and routers can derive seller identity
from `media_buy_id` against their own stores; providers cannot.

TMP remains experimental under AdCP 3.x — schema additions here
follow the experimental-surface contract and do not bump the stable
AdCP major. The `SellerAgentRef.id` slot and optional `ext` namespace
leave room to layer signed seller claims or an AAO-assigned opaque
identifier without a rename later.
