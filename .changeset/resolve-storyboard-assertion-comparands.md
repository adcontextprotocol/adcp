---
"adcontextprotocol": patch
---

compliance: fix two storyboard assertions that compared against an unresolved `$context` token, and gate assertion comparands at build time.

The runner substitutes `validations[].value`, `validations[].allowed_values[]`
and a webhook step's `filter` against the context as it stood *before* the
step, and resolves `validations[].context_key` from the same snapshot. A
step's own `context_outputs` land after its validations run, so a step cannot
assert against a key it captures itself — and unlike requests, nothing guards
this surface. An unresolved `value` silently becomes the comparand (the check
grades the response against the literal string `"$context.<key>"`), an absent
`context_key` makes the check *pass* with a `context_key_absent` observation,
and a token left in a `filter` yields a selector no delivery can match.

Two storyboards did exactly that, so the assertion graded something other than
what it claimed:

- `geo_place_targeting` asserted "current_version is included in
  supported_versions" against `$context.place_system_version`, which the same
  `get_adcp_capabilities` step captures, so no seller could pass the capability
  step. The storyboard now captures `supported_versions` as well and settles
  the `geo-place-catalog-capability.json` `x-adcp-validation.member_of`
  invariant on a second, stateless capabilities read — unconditionally, before
  any product or buy state exists to make it conditional.
- `vendor_metric_accountability` asserted the day-1
  `committed_metrics[].committed_at` equals `confirmed_at` against
  `$context.confirmed_at`, captured by the same `create_media_buy` step, so no
  seller could satisfy it. Every day-1 `committed_at` on both packages is now
  captured on create and settled against the persisted `confirmed_at` on a
  `get_media_buys` read-back that pins the buy under test — "each such entry's
  `committed_at` MUST equal `confirmed_at`", not just the first entry.

`scripts/lint-storyboard-context-resolution.cjs` gains a
`context_assertion_unresolved` rule covering all four comparand surfaces with
the same before-own-capture ordering the request rule uses, so the class is
rejected by `npm run build:compliance` from here on. Released bundles are
immutable, so 3.2.0-beta.6 through 3.2.5 keep both defects and are quarantined
by the frozen table in
`tests/lint-storyboard-context-resolution.test.cjs`.
