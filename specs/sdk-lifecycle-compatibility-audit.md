# SDK lifecycle compatibility audit: AdCP 3.0, 3.1, and 3.2

Audited September 11, 2026 for [#7403](https://github.com/adcontextprotocol/adcp/issues/7403).
This is an implementation audit and review brief. It does not change native
signatures, accepted losses, version negotiation rules, or seller obligations.

## Result

Most of the proposed buyer compatibility architecture already ships in the
TypeScript SDK. Use its `negotiateMediaBuyLifecycle()` coordinator, named
`allowedLosses`, compatibility reports, and purchase continuations. Creating
another compatibility policy or rewriting the native lifecycle is unnecessary.

All nine local TypeScript buyer/seller discovery combinations completed in
RC.33 and RC.35. Existing release tests also exercise purchases, exact retries,
controls, readback, ordinary legacy proposals, and MCP/A2A routing. This is a
substantial implementation, with specific gaps:

1. The listing coordinator rejects **all** `criteria`, even a country-coverage
   filter that the proposal-discovery coordinator already translates.
2. A tokenless legacy listing succeeds, but the direct-buy coordinator still
   requires `feed_version` after the caller accepts legacy fencing limitations.
   The separate products-only brief continuation handles legacy creation, but
   does not automatically complete this wholesale catalog-to-purchase path.
3. Python and Go provide useful versioning and server support, but do not ship
   the same general buyer lifecycle coordinator as TypeScript.
4. Version-selection behavior differs across implementations and from parts
   of the protocol's current pinning rules. Successful routing alone does not
   establish conformance to those rules.

The seller-facing distinction remains important: the SDK keeps registered
legacy handlers callable; it does not generate every legacy business behavior
from compact handlers. That is the remaining premise behind #7403.

## Revisions and evidence scope

| SDK | Audited release | Source revision | Verification |
| --- | --- | --- | --- |
| TypeScript | `@adcp/sdk@14.0.0-rc.35`; boundary/routing probes also run against the protocol repository's `14.0.0-rc.33` dependency | [RC.35 source](https://github.com/adcontextprotocol/adcp-client/tree/2b27442fbaf972f7a4236af227800feec268aeb0) | Published npm packages; release-tag tests run against the published RC.35 build and bundled caches. |
| Python | `adcp==8.0.0b14` / tag `v8.0.0-beta.14` | [813cf2ae](https://github.com/adcontextprotocol/adcp-client-python/tree/813cf2ae03856e9468c4f9b1fd0397be67ab1b1e) | Release-tag source and tests in Python 3.12. |
| Go | module `adcp/v3`, release `adcp/v3.2.1` | [fc9fb2a8](https://github.com/adcontextprotocol/adcp-go/tree/fc9fb2a8af4c91daff0c9457254a64eecdd56551) | Release-tag source and version tests in Go 1.26.2. |

All three releases embed protocol `3.2.0-rc.1`. That is schema/checkpoint
parity, not parity of workflow helpers. TypeScript's relevant coordinator and
compatibility guide have no changes between the audited RC.33 and RC.35 tags.
The TypeScript matrix fixtures use bundled `3.0.25`, `3.1.18`, and
`3.2.0-rc.1`; issue #7403's field comparison uses released `3.1.19`.

This audit uses local fixtures and release tests, not live partner accounts or
archived old SDK binaries. The buyer versions below describe the API/wire
configuration of the current SDK, not historical npm package versions.

## Buyer–seller matrix

The newer seller in these rows retains the legacy handlers and advertises the
older releases. A 3.2-capable buyer uses the existing coordinator; older buyer
configurations keep calling `getProducts`. The served version comes from the
server's `ctx.servedAdcpVersion`, not the incoming request's version field.

| Buyer configuration | Seller ceiling | Observed discovery path | Served contract | Workflow interpretation |
| --- | --- | --- | --- | --- |
| 3.0 | 3.0 | `get_products` | 3.0 | Established workflow. |
| 3.0 | 3.1 | `get_products` | 3.0 | Preserve the older caller's contract. |
| 3.0 | 3.2 | Hidden `get_products` handler | 3.0 | Compact tool advertisement does not remove registered legacy handlers. |
| 3.1 | 3.0 | `get_products` | 3.0 | Newer optional capabilities are unavailable; use the served schema. |
| 3.1 | 3.1 | `get_products` | 3.1 | Established workflow. |
| 3.1 | 3.2 | Hidden `get_products` handler | 3.1 | Existing caller does not need compact lifecycle orchestration. |
| 3.2 | 3.0 | Coordinator → `get_products` | 3.0 | Common subset with explicit mutation-loss boundaries. See tokenless purchase and pinning gaps below. |
| 3.2 | 3.1 | Coordinator → `get_products` | 3.1 | Common subset with explicit mutation-loss boundaries. |
| 3.2 | 3.2 | Coordinator → `list_products` | 3.2 RC.1 | Native tools when advertised. |

These nine probes establish discovery routing, not nine complete campaign
certifications. The existing TypeScript release gate separately exercises
direct creation, replay/conflict, pause/resume/cancel, readback, and legacy
proposal workflows against old-wire fixtures. It also exercises established
and compact lifecycles over the official A2A stack.

The seller's lifecycle shape is another axis:

- A legacy-only 3.2 seller uses the established coordinator path when those
  tools are advertised.
- A partial compact surface is handled per operation. On a negotiated 3.2
  surface, the coordinator does not assume an unadvertised mutation alias is
  callable.
- A compact-only seller cannot serve an unchanged legacy caller merely because
  the SDK supports both tool families. The protocol still requires retaining
  the legacy facades through 3.x; framework configurability is not an exception.
- For callers without version metadata, choose a server default appropriate
  to the existing integration. TypeScript exposes `defaultAdcpVersion`;
  Python's dispatcher defaults unnegotiated traffic to 3.0. Missing metadata
  alone is not a reason to stop a working established workflow.

Sources: TypeScript [compatibility guide and matrix](https://github.com/adcontextprotocol/adcp-client/blob/2b27442fbaf972f7a4236af227800feec268aeb0/docs/guides/MEDIA-BUY-3.2-COMPATIBILITY.md#compatibility-matrix-to-keep-in-ci),
[MCP compatibility tests](https://github.com/adcontextprotocol/adcp-client/blob/2b27442fbaf972f7a4236af227800feec268aeb0/test/lib/media-buy-lifecycle-compatibility.test.js),
and [release gate](https://github.com/adcontextprotocol/adcp-client/blob/2b27442fbaf972f7a4236af227800feec268aeb0/test/lib/media-buy-lifecycle-release-gate.test.js).

## What already ships, by SDK

| Behavior | TypeScript RC.35 | Python beta.14 | Go adcp/v3.2.1 |
| --- | --- | --- | --- |
| Existing tool names and 3.x types | Present; version adapters and canonical projection. | Present; version-scoped validation and dispatch. | Present; generated types and typed tool registration. |
| One buyer coordinator choosing compact/established operations | `AgentClient.negotiateMediaBuyLifecycle()`. Direct `client.listProducts()` is a native call, not this coordinator. | Compact client methods dispatch to the same-named tool. No equivalent general lifecycle selector found. | No equivalent general lifecycle selector found in `adcp/v3`. |
| Explicit degraded mutation behavior | `allowedLosses`, operation reports, and preflight errors are implemented. | Dedicated `LegacyPurchaseCoordinator` accepts per-operation continuation inputs with explicit losses. It requires a store and executor; it is not automatically invoked by `client.buy_products()`. | Application orchestration is required beyond the provided primitives. |
| Products-only legacy purchase continuation | Issuance, redemption, durable state/reconciliation hooks, replay and async handling. | Separate continuation coordinator, SQLite/in-memory stores, replay and reconciliation tests. | No equivalent continuation coordinator found. |
| Seller serves old and new tools | Registered legacy handlers remain callable; `sales` and `mediaBuyLifecycle` coexist. | Base/decisioning handlers cover both families; compact method declarations are checked. | Register appropriate handlers with typed server helpers. |
| Generate all old handlers from new handlers | Not implemented; legacy `sales` handlers/business services remain necessary. | Not implemented; the lifecycle matrix's direct platform inherits its legacy methods. | Not implemented by typed registration. |

Sources: TypeScript [coordinator options](https://github.com/adcontextprotocol/adcp-client/blob/2b27442fbaf972f7a4236af227800feec268aeb0/src/lib/media-buy/compatibility.ts#L695)
and [seller wiring](https://github.com/adcontextprotocol/adcp-client/blob/2b27442fbaf972f7a4236af227800feec268aeb0/src/lib/server/decisioning/runtime/from-platform.ts#L6271);
Python [compact client calls](https://github.com/adcontextprotocol/adcp-client-python/blob/813cf2ae03856e9468c4f9b1fd0397be67ab1b1e/src/adcp/client.py#L2036),
[continuation coordinator](https://github.com/adcontextprotocol/adcp-client-python/blob/813cf2ae03856e9468c4f9b1fd0397be67ab1b1e/src/adcp/compat/purchase_continuation.py#L615),
and [lifecycle matrix](https://github.com/adcontextprotocol/adcp-client-python/blob/813cf2ae03856e9468c4f9b1fd0397be67ab1b1e/tests/test_compact_lifecycle_matrix.py);
Go [typed registration](https://github.com/adcontextprotocol/adcp-go/blob/fc9fb2a8af4c91daff0c9457254a64eecdd56551/adcp/v3/addtool.go).

## Concrete gaps and the smallest follow-ups

### 1. Equivalent listing filters stop before transport

On both 3.0 and 3.1 lanes, `listProducts` with
`criteria.offer_filters.countries` returns `UNSUPPORTED_FEATURE` with feature
`criteria/governance_context/context_id`. The same filter through
`requestProposals` reaches `get_products`. An empty/simple listing succeeds.

The [listing branch](https://github.com/adcontextprotocol/adcp-client/blob/2b27442fbaf972f7a4236af227800feec268aeb0/src/lib/media-buy/compatibility.ts#L5142)
rejects the entire criteria object. This is narrower than "every useful list
filter is incompatible." Reuse the existing field-specific offer-filter
projection for criteria that have exact equivalents in the negotiated schema.
Preserve unsupported-field errors for the rest. Country coverage stays a
product filter and never becomes delivery targeting.

Acceptance: run the same coverage-filtered catalog query on 3.0, 3.1 and 3.2,
assert the actual legacy filter, result eligibility, pagination and diagnostics,
and reject a genuinely unrepresentable criterion before transport. Do not
switch a wholesale query into brief curation to bypass this restriction.

### 2. Tokenless catalog discovery has no direct coordinator purchase

The probe obtains a valid SDK listing result without `feed_version`. With
`allowedLosses` covering both non-atomic feed/pricing checks, the
[direct-buy branch](https://github.com/adcontextprotocol/adcp-client/blob/2b27442fbaf972f7a4236af227800feec268aeb0/src/lib/media-buy/compatibility.ts#L8806)
still rejects a purchase missing `feed_version` before calling create.
Supplying a real observed token on the 3.1 fixture and accepting the losses
succeeds; the SDK sends legacy `packages`, keeps the retry key, removes the
unsupported fence fields, and returns the legacy receipt with its loss report.

The existing [old-wire release fixture](https://github.com/adcontextprotocol/adcp-client/blob/2b27442fbaf972f7a4236af227800feec268aeb0/test/lib/media-buy-lifecycle-release-gate.test.js#L123)
always supplies `wholesale_feed_version` and `pricing_version`, including in its
3.0 lane. Those extra fields pass its open legacy schema, but they are not a
guarantee of an unchanged 3.0 seller. That explains why the full direct-purchase
test passes while the tokenless case remains uncovered.

Retain native `buy_products` requirements. The bounded SDK follow-up is to
connect eligible tokenless catalog selections to existing legacy purchase
coordination, retaining explicit losses, account/selection binding, and retry
handling. First establish the SDK-local input and continuation entry point;
do not add a fake token or silently broaden the native method's result contract.
Today applications can call the established creation API directly, or use the
existing products-only **brief** continuation where that is their workflow.
The catalog path is the missing convenience, not the ability to buy on 3.0.

Acceptance: a 3.0 listing without feed/pricing extras can proceed to an ordinary
legacy purchase under the existing loss policy, return a real legacy receipt,
and resume safely. Requiring enforceable observed terms still stops that path.

### 3. Cross-language claims need workflow precision

Python's `list_products` and `buy_products` call `_execute_typed_task` with
those names. Its matrix tests explicitly verify same-named transport dispatch.
The separate legacy continuation coordinator is substantial existing work,
but it is not a general automatic compact-to-legacy router. Go's module supplies
version helpers, generated shapes, and server primitives rather than that router.

Keep the existing layer-coverage matrix, and add operation-level guidance:
which public entry point negotiates, which is native-only, what losses require
configuration, and what orchestration remains application-owned. Port proven
TypeScript workflows incrementally if adopters need parity. Do not describe
embedded RC.1 schemas as evidence of equal lifecycle automation.

### 4. Version selection and exact pins need a shared regression set

The nine TypeScript routing probes show successful degradation, but also show
the automatically emitted `3.2-rc.1` request field reaching a 3.0/3.1 handler
whose `servedAdcpVersion` is older. The coordinator reports the older version.
This is useful interoperability, but it differs from a blanket reading of the
protocol rule that explicit prerelease pins require an exact match.

The [Go helper and tests](https://github.com/adcontextprotocol/adcp-go/blob/fc9fb2a8af4c91daff0c9457254a64eecdd56551/adcp/v3/version_test.go#L43)
also accept a stable 3.2 request on an RC-only peer and substitute a stable
release for a prerelease pin. Conversely, Python's
[payload resolver](https://github.com/adcontextprotocol/adcp-client-python/blob/813cf2ae03856e9468c4f9b1fd0397be67ab1b1e/src/adcp/validation/envelope.py#L64)
requires an explicit normalized version to belong to its supported set; by
itself it does not implement same-major minor downshift. Its major-only default
prefers 3.0, whereas Go prefers the highest stable minor.

Separate the SDK's supported/preferred bundle from an application's explicit
per-operation contract requirement. Share vectors for stable minor downshift,
exact prerelease pins, omitted metadata, response echo, and served-version
validation. Preserve normal legacy routing while preventing an explicit
requirement from being silently weakened. This PR records the divergence;
it does not relax the [published pinning policy](../docs/reference/versioning.mdx).

### 5. Seller facade coverage is narrower than handler registration

The original issue is old buyer → new seller. TypeScript's guide asks sellers
to retain `sales` alongside `mediaBuyLifecycle`; the framework registers both.
Python's direct-lifecycle matrix platform inherits legacy methods. Neither is
evidence that an adopter can delete the old business behavior after adding
compact endpoints.

Keep shared seller services and the current contract. Audit existing adapters
with the issue's actual inputs: named formats; country and sub-country coverage;
signal include/exclude eligibility; curation preferences and time budgets;
requested response fields; empty/duplicate policy sets; inline catalogs; and
oversized or atomic refinement batches. These are targeted coverage gaps, not
a reason to add every legacy field to native compact signatures.

The raw 3.1 request must remain authoritative on a seller claiming that version.
Internal normalization can omit empty policy sets and deduplicate policy IDs.
It cannot drop eligibility predicates, turn coverage into targeting, split an
atomic mutation, or reinterpret omitted proposals as terminal decline. The
existing [compatibility contract](legacy-compact-lifecycle-compatibility.md)
already supplies the transaction-boundary rules; add scenario coverage rather
than another lifecycle policy.

Note on current reach: sub-country coverage predicates — `metros`, `regions`,
`postal_areas`, and `geo_proximity` — have no compact home in
`core/product-offer-filters.json`. For those predicates, this section's
rule (do not drop eligibility predicates; do not convert coverage into
targeting) is jointly unsatisfiable under current compact internals: refusal
is the only currently compliant path. The schema gap is tracked in
[#7403](https://github.com/adcontextprotocol/adcp/issues/7403).

## Making adoption smoother now

1. Point mixed-version TypeScript buyers to the **existing coordinator** and its
   compatibility report. Keep raw/native task calls clearly identified.
2. Document the current named-loss opt-ins and products-only continuation APIs.
   A 3.2-capable SDK can buy under 3.0/3.1 semantics without claiming new guarantees.
3. Retain registered legacy seller handlers and configure the unversioned
   default for the installed buyer population. Inspect the served-version
   context; the incoming requested version can be higher.
4. Prioritize equivalent listing filters and the tokenless catalog purchase
   handoff in TypeScript. Both are specific improvements to existing machinery.
5. Give Python/Go adopters accurate entry-point coverage and use the same
   scenario definitions for subsequent parity work.

These are SDK/documentation follow-ups. This audit does not propose new
deprecations, a new compatibility consent model, or a change to the 3.x
requirement to retain advertised legacy behavior.

## SDK issue ownership

The original continuation work already has issues in every official SDK.
The new audit findings now have language-specific follow-ups as well. Status
below was checked on September 11, 2026; an open implementation PR is not
evidence that its behavior shipped in the audited release.

| SDK | Existing continuation work | Audit follow-up |
| --- | --- | --- |
| TypeScript | [#2640](https://github.com/adcontextprotocol/adcp-client/issues/2640) is completed, with implementation in [#2641](https://github.com/adcontextprotocol/adcp-client/pull/2641) and settlement fixes in [#2642](https://github.com/adcontextprotocol/adcp-client/pull/2642). | [#2874](https://github.com/adcontextprotocol/adcp-client/issues/2874) covers equivalent listing filters, tokenless catalog purchase coordination, and legacy workflow regressions. It links the existing [#1069](https://github.com/adcontextprotocol/adcp-client/issues/1069) cross-version/served-version follow-up for the version-policy cases. |
| Python | [#1057](https://github.com/adcontextprotocol/adcp-client-python/issues/1057) is completed via [#1059](https://github.com/adcontextprotocol/adcp-client-python/pull/1059). | [#1146](https://github.com/adcontextprotocol/adcp-client-python/issues/1146) covers an explicit negotiated catalog/purchase helper reusing that work, degraded capabilities, and version/legacy-handler regression cases. It does not request a second continuation implementation or automatic rewriting of native task calls. |
| Go | [#466](https://github.com/adcontextprotocol/adcp-go/issues/466) remains open with implementation PR [#483](https://github.com/adcontextprotocol/adcp-go/pull/483). [#482](https://github.com/adcontextprotocol/adcp-go/issues/482) separately tracks persistent storage and the reverse seller facade. | [#527](https://github.com/adcontextprotocol/adcp-go/issues/527) covers exact release pins and server-dispatch regression cases. Reuse the existing [#351](https://github.com/adcontextprotocol/adcp-go/issues/351) testing work and [#352](https://github.com/adcontextprotocol/adcp-go/issues/352) SDK roadmap for broader orchestration support. |

These issues link back to [the audit PR](https://github.com/adcontextprotocol/adcp/pull/7420)
and distinguish new gaps from completed or ongoing SDK work. The broader
seller field-preservation comparison remains in
[#7403](https://github.com/adcontextprotocol/adcp/issues/7403); closing a buyer
helper issue does not establish complete reverse-facade coverage.

## Validation and reproduction

- TypeScript: 290 passing coordinator/release-gate tests, including actual
  in-memory MCP and local A2A paths. The separate compatibility/version run
  passed 17 tests covering hidden legacy handlers and release normalization.
- Python: 55 passing version/dispatch/lifecycle tests plus 125 passing
  continuation/version-helper tests. These do not establish a general buyer
  lifecycle selector; the compact routing tests verify native task dispatch.
- Go: four selected top-level version/shape tests passed, including cases that
  encode the pinning divergence above. Passing SDK tests does not establish
  agreement with the protocol on those cases.
- Local probes: 11 coordinator boundary observations and all nine MCP discovery
  routes on both TypeScript RC.33 and RC.35 produced the same outcomes.

Run the [audit script](../scripts/audit-sdk-lifecycle-compatibility.cjs) after
installing this repository's dependencies:

```sh
node scripts/audit-sdk-lifecycle-compatibility.cjs
```

To inspect another installed SDK release, pass its package directory:

```sh
node scripts/audit-sdk-lifecycle-compatibility.cjs /absolute/path/to/node_modules/@adcp/sdk
```

The script makes no external seller calls. Its first section replaces client
transport methods with local boundary fixtures. Its routing section uses the
official MCP in-memory transport and real SDK server/version dispatch. Empty
catalog fixtures isolate routing; they do not prove filtering or fulfillment.
It prints observations rather than freezing current limitations as desired
test outcomes. Native response conformance, signing, live partner behavior,
and every possible legacy request shape are outside those probes' evidence.

Upstream commands used at the pinned revisions:

```sh
# TypeScript: published build plus matching release-tag test sources/caches.
node --test test/lib/media-buy-lifecycle-coordinator.test.js test/lib/media-buy-lifecycle-release-gate.test.js
node --test test/lib/media-buy-lifecycle-compatibility.test.js test/lib/adcp-version-release-precision.test.js

# Python: release-tag checkout installed with development dependencies.
python -m pytest -q tests/test_version_interop.py tests/test_client_server_version.py tests/test_dispatcher_version_routing.py tests/test_compact_lifecycle_matrix.py tests/test_validation_version.py
python -m pytest -q tests/test_purchase_continuation.py tests/test_version_helpers.py

# Go: run from adcp/v3, outside the multi-module workspace.
GOWORK=off go test -run 'Test(NormalizeADCPVersion|VersionEnvelopeFor|NegotiateADCPVersion|GeneratedRequestsDecodeSupportedVersionEnvelopes)$' -v .
```

The published TypeScript cache needs `compliance/cache/latest` to resolve to
its embedded `3.2.0-rc.1` cache for the release-tag coordinator tests. This is
local harness setup; no released protocol artifact was rewritten.
