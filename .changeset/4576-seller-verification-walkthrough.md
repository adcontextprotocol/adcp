---
---

docs(verification): seller verification walkthrough — buyer-side end-to-end chain (closes #4576)

Adds [`docs/verification/overview`](https://docs.adcontextprotocol.org/docs/verification/overview), the buyer-facing companion to `docs/trust.mdx`. Walks through how a buyer (Sam) verifies an unfamiliar seller end-to-end in five steps:

1. **Signature** — verify the RFC 9421 signature on the `get_products` response
2. **brand.json** — pull the seller's self-declaration and bind `keyid` to brand identity
3. **adagents.json** — confirm the publisher's bilateral authorization (delegation_type match + signing_keys binding)
4. **Parent house** — walk the brand-portfolio hierarchy to a recognized owner
5. **Bounded honesty** — name what the chain does not prove: human-layer (KYC, real operator, legal counterparty) and delivery-time (avails, CPM, delivery)

Story-driven walkthrough using the existing cast (Sam from `signals/overview.mdx`, Acme Outdoor from `governance/overview.mdx`) for continuity. Six illustrated steps with character-driven scenes matching the visual conventions of governance / signals / sponsored-intelligence overviews. All images C2PA-signed at generation time.

`docs/trust.mdx` already names the structural surfaces; this doc shows a buyer walking through them in code. Slotted into the Trust & Security nav group as a peer to Trust, AI Disclosure, Privacy Considerations, and Known Limitations.

Closes #4576.
