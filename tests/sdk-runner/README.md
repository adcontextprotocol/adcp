# `@adcp-protocol/fixture-test-sdk`

Private, test-only. Nothing here ships.

## Why it exists

`static/compliance/source/protocols/media-buy/scenarios/inline_creatives_without_sync.yaml`
gates its three canonical paths with `skip_if` expressions that read **captured
context** (for example
`!context.canonical_declaration || context.canonical_declaration.format_option_id`).

The root project's production `@adcp/sdk` is **9.6.2**, whose `skip_if` grammar
only matches `test_kit.*`; any other expression is ignored and the phase runs
anyway. That runner therefore cannot execute this storyboard at all, so the
regression tests cannot be written against it.

This package pins a published `@adcp/sdk` **17.0.0-beta.8** so
`tests/cli-scenario-fixtures.test.cjs` can evaluate those guards and the auction-only
seller regressions can enrich valid semantic rejection probes. Its conflicting peers (`@a2a-js/sdk` 1.x vs the root's 0.3.x) nest under
`tests/sdk-runner/node_modules`, so **root production resolution is unchanged**:
`@adcp/sdk` 9.6.2 with `@a2a-js/sdk` 0.3.x.

## Verified runner floor

Context-aware `skip_if` is **verified present in 15.8.1 and 15.9.2** and
**verified absent in 9.6.2**. Versions between 9.6.3 and 15.8.0 were not tested,
so the floor is stated as "≥15.8.1 verified", not as an exact first version.
15.8.1 is the version the hosted grader runs.

This is not a new floor for the branch: `billing_out_of_band`, `evaluator_auth`
and `refine_finalize_exclusivity` already ship context-reading `skip_if` on
3.1.x.

The seller fixture-discovery and complete product-feed checks are verified
against the pinned 17.0.0-beta.8 runner. Collected reads declare
`collect_product_pages_runner`; older runners report that slice as unavailable
instead of treating a partial feed as a complete result.

## Rules

- **Never import this from `server/src/`.** Production runtime code uses `@adcp/sdk`, which
  stays 9.6.2. This package is a `devDependency` (`file:tests/sdk-runner`) and
  is absent from a production install.
- Only `./testing` is forwarded. The current-source seller manual cohort also uses
  this runner; unrelated cohorts and frozen 3.0 compatibility keep SDK 9.6.2.
  Do not add forwarders speculatively.
- Bumping the pin here has no effect on the server or on any published artifact.
