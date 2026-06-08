---
"adcontextprotocol": patch
---

spec(tmp): add required `seller_agent_url` to `context_match_request`.

The context-match request now carries `seller_agent_url`, matching the identity-match request's field shape and placement (PR #3687). The resolution semantics are deliberately actor-specific, not a mirror: on the context path the **provider** resolves the active package set it has **synced** for the asking seller, whereas on the identity path the **buyer agent** resolves the set it has **registered**. When `package_ids` is omitted, evaluation runs against that seller's full active set; a `seller_agent_url` the provider has not synced packages for MUST return an empty offer set rather than fall back to another seller's set.

This reverses the prior decision (PR #3063's seller-attribution section) that kept seller identity off `context_match_request`. That section argued the provider already holds the sync-time `seller_agent` binding so the request field is redundant, and that putting seller on the context path opens a request-time filtering vector. In practice a provider serves many sellers and needs the asking seller's identity on the wire to scope its active-set resolution without a deployment-pinned constant — the same need the buyer agent has on the identity path, even though the actor and the set it resolves against differ. The decorrelation argument does not apply: `seller_agent_url` is a single stable value identifying the asking seller, identical for every user on a placement and carrying no user identity, so it adds no per-user signal that context and identity requests could be correlated on. The package-set decorrelation guarantee constrains per-user-varying data (`package_ids`), which is unchanged.

Required, consistent with identity-match. `context_match_request` is `x-status: experimental`, so the added required field is permitted pre-stable.

Files:
- `static/schemas/source/tmp/context-match-request.json` — `seller_agent_url` property (string, uri) added to `properties` and to `required`.
- `docs/trusted-match/specification.mdx` — §Seller Attribution "Placement rationale", the Router participant row, and the "What This Is Not" bullet rewritten so the normative text matches: both request types carry `seller_agent_url`; the package-side `seller_agent` remains attribution-only; neither may be used as a per-user filter.
- `docs/trusted-match/{index,buyer-guide,context-and-identity,ai-mediation}.mdx` and `docs/trusted-match/surfaces/{web,mobile,ctv,ai-assistants,retail-media}.mdx` — request examples updated with `seller_agent_url`.
- `tests/example-validation-simple.test.cjs` — both context-match request fixtures updated.
