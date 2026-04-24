---
---

spec(media-buy): `get_media_buys` MUST return all account-owned buys regardless of creation surface

Tightens the scope of `get_media_buys`, `get_media_buy_delivery`, and `update_media_buy` to be bounded by account ownership, not by the surface through which a buy was created. A sales agent MUST NOT partition its inventory into "AdCP-created" and "non-AdCP" subsets for account-scoped tasks, and MUST NOT refuse reporting or updates on the basis that a buy was booked directly in the ad server, via legacy APIs, or via manual trafficking.

Closes #2963. Rationale:

- **Adoption**: enterprises with large existing ad-server state (10K+ GAM campaigns) can't rebuild from zero through AdCP to adopt the protocol.
- **Attestation**: brownfield Tier-2 conformance (#2965) depends on the compliance engine being able to `get_media_buys` → discover a live campaign → `update_media_buy` with a verification `reporting_webhook`. If pre-existing campaigns are invisible, that path collapses.
- **Honesty**: AdCP is a protocol onto the seller's ad operations, not a shadow ledger beside them.

Normative changes:

- `docs/media-buy/task-reference/get_media_buys.mdx`: new "Scope of Results" section.
- `docs/media-buy/task-reference/update_media_buy.mdx`: new "Scope" section; updates operate on any `media_buy_id` returned by `get_media_buys`.
- `docs/media-buy/task-reference/get_media_buy_delivery.mdx`: new "Scope" section; delivery reporting covers any returned buy.
- `docs/media-buy/specification.mdx`: new "Account Ownership vs. Creation Surface" core concept; cross-referenced from the `get_media_buys`, `update_media_buy`, and `get_media_buy_delivery` requirements lists.

Business constraints on specific operations remain expressible via `valid_actions` — the seller omits the action rather than hiding the buy.
