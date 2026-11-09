---
"adcontextprotocol": minor
---

State what accepting signed commercial terms means. `terms_digest` covers the entire `commercial_terms` JSON value: every member at every depth, including `ext` and members a party does not recognize. Several schemas inside `commercial_terms` are already open, so the signed bytes can carry members a party's release does not define.

- Accepting the terms binds the accepting party to every member. A party that cannot interpret every member MUST NOT accept them: a buyer declines with the new `decline_proposals` reason `unrecognized_terms`, a seller rejects the request that carries them (such as `buy_products` purchases) with the new error code `UNRECOGNIZED_TERMS`, and a governance agent denies the check. A member whose schema defines it as opaque, such as `context`, is interpreted by that definition.
- A party computes or verifies `terms_digest` over the JSON value as received, never over a re-serialized parsed model, which can drop members the model does not declare.

The rule is stated in `media-buy/commercial-terms.json`, the `terms_digest` description in `core/canonical-proposal.json`, `governance/check-governance-request.json`, and the proposal negotiation, `buy_products`, `decline_proposals`, and `check_governance` pages. The release notes, What's new in 3.3, and the migration guides no longer say that `terms_digest` "signs exactly those terms" as a reason for keeping `commercial-terms` closed; it stays closed because a minor release never changes a closed schema. No schema is opened or closed.

The new storyboard `media_buy_seller/unrecognized_terms_rejected` sends a `buy_products` purchase whose `format_option_refs[0]` carries a member no release defines and expects `UNRECOGNIZED_TERMS`, then sends the same purchase without it and expects a MediaBuy.
