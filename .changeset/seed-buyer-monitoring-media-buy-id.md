---
"adcontextprotocol": patch
---

compliance: seed `media_buy_id` in the `buyer_monitoring` storyboard and reject unresolvable `$context` tokens at build time.

`buyer_monitoring` polls delivery for the buy declared in
`fixtures.fixture_publisher.active_buy`, but no step in the storyboard creates
one, so `$context.media_buy_id` had no writer and both delivery reads could
only ever skip with `prerequisite_failed`. The root `context:` block now seeds
it from the same fixture id.

A new `scripts/lint-storyboard-context-resolution.cjs` runs as a hard gate in
`npm run build:compliance`. It replays the runner's `injectContext()`
substitution in step order over every `sample_request` and fails when a
`$context.<key>` has nothing to resolve it — the defect class that shipped in
every 3.0 bundle up to 3.0.26 (#7797, fixed for 3.0.27 by #7801) and in the
3.2 bundles through 3.2.5. It also rejects a `context_outputs` capture of
`governance_agent_url` or the `*_agent_url` keys hosted grading seeds from
server config, which would let the agent under test redirect the governance
agent it is told to trust.
