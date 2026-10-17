---
title: Optional product feature applicability in conformance
class: normative
status: proposed
date: 2026-10-16
refs: ["#8254", "DR-0001", "DR-0010"]
---

This is a decision proposal, not an operative protocol rule or a fix to the
published compliance bundle. Human/WG ratification is required before adopting
an applicability policy. The implementation issue remains open:
[#8254](https://github.com/adcontextprotocol/adcp/issues/8254).

## Decision requested

Choose the evidence that makes an optional product feature applicable:

1. A qualifying seller-owned product discovered in the sandbox catalog, with
   explicit coverage gaps when no such product is discoverable; or
2. A separately approved seller-wide support declaration that commits a seller
   to relevant controlled fixtures, including support absent from its initial
   sandbox catalog.

Also confirm that format breakdown and time-based views are independent scopes,
and choose whether advanced delivery tests should assert only current normative
guarantees or use a separately specified controller contract to inject observed
format rows and time-threshold measurements.

**Recommendation:** choose catalog evidence for the existing product-scoped
features, split independent coverage, and constrain reporting assertions to
current normative guarantees. Treat unavailable qualifying products as explicit
`fixture_unsatisfied` coverage gaps, projected as `not_applicable`, never as a
pass or proof that a seller lacks the feature. Accept and display the resulting
seeded-only and brief-only coverage limitations explicitly. If those limitations
are unacceptable, choose declaration-based applicability in a future minor
instead; no new declaration is designed or added by this proposal.

## Rationale and existing authority

- [DR-0001](../governance/decisions/DR-0001-conformance-assertions-normative-basis.md)
  requires a normative basis for every graded assertion. Optional product
  features cannot become universal requirements through a fixture exemplar.
- [Product declarations](../static/schemas/source/core/product.json) make
  `collections` optional and `collection_targeting_allowed` default to false.
  The [collection readback obligation](../docs/media-buy/product-discovery/collections-and-installments.mdx)
  applies after a selection is committed. It does not require every seller to
  offer selectable collections or owner-sold carriage.
- [Reporting declarations](../static/schemas/source/core/reporting-capabilities.json)
  independently describe `supports_format_breakdown` and `available_metrics`.
  The [delivery request](../static/schemas/source/media-buy/get-media-buy-delivery-request.json)
  allows unavailable requested metrics to be omitted and requires requested
  dimensions only when the selected product declares them supported.
- [DR-0010](../governance/decisions/DR-0010-fixture-handles-and-resolution.md) and
  the [fixture resolution contract](../static/compliance/source/universal/storyboard-schema.yaml)
  already permit explicit `strategies: [discover]`. Discovery enumerates a
  fully paginated wholesale catalog with schema validation and sandbox scope.
  A valid no-match is unavailable; transport, schema, protocol, pagination and
  supported setup failures are terminal. Failures cannot be hidden by fallback.
- The [controller contract](../docs/building/by-layer/L3/comply-test-controller.mdx)
  permits rejecting clearly malformed fixtures; it does not negotiate optional
  product features on otherwise valid seeds. Successful `seed_product` proves
  setup acceptance, not native feature support. `[seed, discover]` still seeds
  an invented feature before inspecting the catalog.
- Existing controller, required-tool and wholesale gates establish their own
  prerequisites. None establishes collection or advanced reporting support.
  `collection_list` is a different feature from `collection_selection`.

## Why a gate-only patch is insufficient

| Current storyboard | Separate scopes and obstacles |
| --- | --- |
| `collection_selection` | Selectable subset/default materialization and fixed-bundle enforcement need independent fixture graphs. Requiring both products can suppress applicable selectable coverage when the fixed companion is missing, or vice versa. An omitted default-false flag must qualify as fixed; the current AND-only match DSL cannot express omitted-or-false directly. |
| `owner_sold_channel_carriage` | A selectable collection product does not by itself prove owner/host carriage. Match actual owner/host product structure and retain valid-selection, unknown-selection and mismatched-domain rejection checks. Host authorization remains buyer-side verification outside this wire-visible storyboard. |
| `advanced_delivery_reporting` | Format breakdown and time-based views are independent per-product features. A combined AND gate skips format-only and time-metric-only sellers. Baseline metric narrowing remains graded independently. |

Both collection storyboards embed illustrative collection IDs, domains, host
properties and commercial terms in requests and assertions. Fixture binding
substitutes schema-annotated entity identities; it does not turn these literals
into the selected seller's selectors or rewrite expected values. Matching the
illustrative strings excludes real supporting catalogs; matching only a support
flag while retaining the old steps tests the wrong inventory. An implementation
must derive selectors and prices from the pinned seller product and retain
negative tests that cannot accidentally name another valid selector.

Discover-only also introduces wholesale enumeration into collection tests that
currently use brief discovery. A brief-only supporting seller and a seller
whose support exists only after seeding have unknown applicability through this
mechanism. Their coverage gaps must be visible, with the discovery prerequisite
distinguished from a successful catalog scan with no qualifying product.

Advanced reporting has an additional independent defect under DR-0001:
[`delivery-metrics.json`](../static/schemas/source/core/delivery-metrics.json)
allows any seller-defined time threshold; two and six seconds are recommended.
The controller injects impressions, clicks and spend, not observed time-view
entries or format rows. Neither a `2`/`play_time` first entry, a `video_hosted`
first row, nor `by_format_truncated: true` follows from those inputs. A supported
requested dimension may return an empty array. Preserve mandatory array and
companion metadata checks, requested-metric narrowing, and actual applied-sort
semantics; do not require invented observations or a particular seller threshold.
An explicit deterministic grain-injection contract would be separate work.

## Alternatives and release consequences

| Alternative | Benefit | Cost / recommendation |
| --- | --- | --- |
| Catalog evidence, independent scopes | Existing discovery contract identifies product declarations without inventing seller-wide claims. | Recommended, subject to explicit acceptance of catalog coverage limits. Requires semantic storyboard rewrites and handling fixed-bundle defaults; not just three `fixture_resolution` blocks. Harness-only changes can be evaluated for a 3.2.x patch after implementation review. |
| Independent seller-wide declarations | Retains seeded coverage for supporting sellers with initially empty catalogs. | Requires WG design, independent feature scopes and a minor changeset; stable-schema field additions cannot be backported to 3.2.x. No field names are proposed here. |
| Negotiate supported fixture features | Could qualify controlled setup before seed execution. | A new controller contract, not an interpretation of `INVALID_PARAMS` or `UNKNOWN_SCENARIO`; broader than this issue. Do not implement implicitly. |
| Keep seed-only applicability or skip all optional failures | Small diff. | Reject: generic setup does not establish native support; blanket skips conceal broken advertised or selected paths. |

This proposal changes no published schema, task, storyboard, grading policy or
controller contract and carries no protocol changeset. An adopted implementation
must include its appropriate protocol changeset. Land any patch-compatible fix
on main first, then prepare a separate 3.2.x backport. Do not modify existing
versioned artifacts or cut a release as part of this issue.

## Executable evidence and implementation acceptance

Run the existing SDK contract probes with:

```bash
node --test --test-timeout=30000 specs/optional-product-feature-applicability/probes.test.cjs
```

The probes use the installed, pinned SDK and schema-validated fixture discovery
with injected clients. They execute independent no-match and supporting-product
paths, preserve failures after selection, reject failed discovery without seed
fallback, demonstrate that seed-first never discovers the native catalog, and
demonstrate all-or-nothing companion suppression. These are decision evidence,
not regression coverage of repaired published storyboards. CI runs them
separately from the source-storyboard matrix.

Before an implementation may merge, execute the actual revised source
storyboards and hosted disposition policy against this acceptance matrix:

| Seller / condition | Required observation |
| --- | --- |
| Controller/seed support, no collection or advanced reporting products | Honest `not_applicable` coverage gaps; no optional feature invented by seeding. |
| Supporting seller with seller-issued product, pricing and selector identities | Resolve real identities and exercise selected/default collection purchase and readback. |
| Seller drops, substitutes or widens a committed selection | Graded failure after successful applicability resolution. |
| Fixed-bundle-only seller, flag omitted or explicitly false | Fixed subset rejection and exact-restatement checks run independently of selectable products. |
| Owner-sold seller / ordinary selectable-collection seller | Owner/host-specific scope applies only to the former; actual selector boundaries remain graded. |
| Format-only seller / time-metric-only seller | Each supported feature is independently exercised. |
| Valid three-second `in_view` measurements / zero observed format rows | Accept permitted data without imposing two-second playback observations or forced truncation. |
| Applicable seller omits required format array or companions | Graded failure. |
| Malformed/rejected/transport-failed discovery or broken pagination | Terminal failure evidence; no applicability skip or seed fallback. |
| Advertised seed/setup operation fails | Retain failed setup evidence and hosted setup-gap disposition; do not recast as unsupported feature. |
| Seeded-only or brief-only supporting seller | Explicit coverage limitation under catalog evidence, or covered through the separately approved declaration approach. |
| Baseline requested-metric narrowing broken | Baseline failure remains graded regardless of optional feature applicability. |

Sibling [#8252](https://github.com/adcontextprotocol/adcp/issues/8252) owns
`product_filter_behavior`; [#8253](https://github.com/adcontextprotocol/adcp/issues/8253)
owns optional-tool gates. Their fixes do not resolve this applicability choice.
No independent expert analysis constitutes human/WG ratification.
