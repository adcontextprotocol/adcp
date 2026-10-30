---
title: Creative 3.3 beta sandbox
description: "Exercise AdCP 3.3 beta creative workflows with the published SDK, isolated sandbox accounts, draft previews, and explicit delivery simulations."
"og:title": "AdCP — creative 3.3 beta sandbox"
---

# Creative 3.3 beta sandbox

This development lab serves the frozen AdCP `3.3.0-beta.1` contract using the
published TypeScript SDK `17.0.0-beta.6`. Its MCP endpoint is:

`https://test-agent.adcontextprotocol.org/beta/3.3/creative/mcp`

The wire selector is `3.3-beta.1`. The endpoint defaults to that beta and
rejects stable or other prerelease selectors. Capability discovery lists only
this release and the implemented creative fixture contracts. All operations
finish synchronously.

## Connect

Use the documented public test-agent bearer credential or an accepted test-agent
API credential. Cookie authentication does not authorize the endpoint. Each
credential resolves its own sandbox account, available through `list_accounts`;
`account: { account_id: "creative33_sandbox" }` is an alias for that caller's
account. People using the same public credential share its sandbox.

Production installations enable the route with
`ENABLE_ADCP_3_3_CREATIVE_ROUTE=true`; the public training-agent deployment opts
in through `fly.toml`. Test and development processes enable it by default.
The beta library, revision bindings, replay keys, and controller fixtures are
separate from the existing training-agent tenants. Production uses the existing
Postgres state and idempotency tables with dedicated namespaces.

## Exercise the buyer workflow

1. Call `get_adcp_capabilities` and choose an entry from
   `creative.supported_formats`. The catalog declares its actual input slots,
   delivery types, and sizes.
2. Invoke `build_creative` through the SDK's typed
   `agent.executeTask('build_creative', request)` API. The responsive ZIP and
   display-tag builders return deterministic first-party fixtures. The
   `beta_video_15s` builder consumes a typed `video_brief` manifest whose
   sequential segments total 15 seconds and returns a playable 640×360 MP4
   fixture. This is a fixed sandbox sample, not generated campaign footage.
3. Upload the resulting manifest with `sync_creatives`, an explicit
   `revision_id`, and a fresh `idempotency_key`. Read it back with
   `list_creatives` to inspect the complete source asset, including its
   selectable sizes. `validate_input` checks inline manifests against the
   advertised capability contracts without storing them.
4. Preview a stored creative with `request_type: "single"`. For responsive
   assets, select a supported canvas through an input's `AD_WIDTH` and
   `AD_HEIGHT` macros. The sandbox returns `quality_used: "draft"` and an
   escaped visualization of the selected canvas. It does not fetch or execute
   uploaded ZIP archives, HTML, or third-party tags. Consumers must still use
   the sandbox/CSP handling described in the preview documentation.
5. Call `get_creative_delivery` before simulating execution: the creative has
   zero delivery and no served variants. To exercise execution readback, use
   `comply_test_controller` with `seed_media_buy`. Its fixture contains one
   package with a matching `format_kind`, concrete `params.width` and
   `params.height`, and one `creative_assignments` entry. Then call the
   existing `simulate_delivery` scenario with that `media_buy_id` and metrics.
   Delivery readback now identifies that simulated buy, the selected fixed
   canvas, and the source revision. The library's responsive source stays
   intact. These controller-created records are test evidence, not physical
   campaign delivery or proof that an arbitrary external tag resizes.

The two display canvases are 300×250 and 728×90. Unsupported selections fail.
Raw inline HTML has a separate discovered, digest-pinned custom contract for
library storage and draft preview; it is not accepted as an HTML5 ZIP or a
third-party display tag and cannot be assigned simulated delivery. Source
briefs likewise must be built into finished video before delivery simulation.

The sandbox intentionally bounds library and execution state. It supports the
advertised fixtures and returns explicit errors for unsupported operations,
including asynchronous tasks, push notifications, and exact variant replay.
Requests are limited to 256 KB and individual manifests to 64 KB. Strict sync
batches apply atomically; `validation_mode: "lenient"` opts into per-item
acceptance. Duplicate JSON members, invalid Unicode scalars, and non-finite
numbers are rejected before source comparison. Hosts embedding the router must
capture the original JSON body in their parser's `verify` callback.

For cleanup, the controller's `force_creative_purge` scenario accepts a specific
`creative_id` and `purge_kind: "hard"`. It removes that caller's source,
associated simulation fixtures, and revision bindings. Reusing an ID afterward
starts a new creative incarnation, as required by the frozen hard-purge
contract. This lab does not support soft tombstones or retention commitments.

## Repeat the checks

Run `npm run test:creative33-sandbox` from the repository root. The suite starts
the actual HTTP endpoint and uses the published SDK for discovery, build,
upload, readback, preview, and controlled delivery simulation. It checks both
display sizes, typed brief consumption, playable video duration, source field
preservation, immutable revisions, version pins, replay behavior, and caller
isolation. No mutable source schema bundle is substituted for the beta.

The required Build Check workflow runs this suite explicitly. The same files
also participate in the server unit test shards.
