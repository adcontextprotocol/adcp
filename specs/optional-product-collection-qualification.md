# Catalog-qualified optional collection checks

This is the implementation record for #8254's collection work. Reporting was
separately corrected in [#8336](https://github.com/adcontextprotocol/adcp/pull/8336).
It supersedes the unimplemented prerequisites in
[#8259](https://github.com/adcontextprotocol/adcp/pull/8259); that proposal's old
SDK15.9.5/pristine15.9.6 defect observations remain historical evidence at its
original head, not qualification of current production behavior.

## Existing authority and release scope

[DR-0010](../governance/decisions/DR-0010-fixture-handles-and-resolution.md) defines
fixture handles, scoped pricing identities, pinned whole-graph resolution,
terminal discovery failures and `fixture_unsatisfied` coverage gaps. The merged
[SDK foundation #3354](https://github.com/adcontextprotocol/adcp-client/pull/3354)
and [authoring/output contract #8376](https://github.com/adcontextprotocol/adcp/pull/8376)
supply the predicate, captures, pair-set comparison and authenticated preparation.
The implementation uses the already installed public npm SDK16.3.0. No dependency,
lockfile, installer, capability declaration or controller contract changes here.

This is a protocol-package **patch** to existing compliance obligations on main,
with new scenario IDs introduced in the upcoming 3.3 line. It does not ratify
[future declarations #8333](https://github.com/adcontextprotocol/adcp/pull/8333),
qualify SDK14/9, prepare a maintenance backport or authorize publication. The
proposed DR-0028 specialism is not authority for these applicability rules.

## Independent applicability scopes

All IDs below have the `media_buy_seller/` prefix. Each resolves its own product
and SAME-parent fixed-price CPM option; no missing companion suppresses another.

| Scenario                                      | Product predicate                          | Graded behavior                                                |
| --------------------------------------------- | ------------------------------------------ | -------------------------------------------------------------- |
| `collection_selection`                        | selectable, 2 distinct pairs               | Strict subset; undeclared ID and domain rejected               |
| `collection_default_materialization`          | any, 1 pair                                | Default materializes the complete concrete set                 |
| `fixed_bundle_enforcement`                    | fixed, 2 distinct pairs                    | Full set accepted; strict subset rejected                      |
| `fixed_bundle_restatement`                    | fixed, 1 pair                              | Exact full-set restatement accepted                            |
| `owner_sold_channel_carriage`                 | any, 1 pair, cross-publisher               | Full set accepted; bulk-form and undeclared selectors rejected |
| `owner_sold_channel_subset`                   | selectable, 2 total pairs, cross-publisher | Strict subset retains the external collection pair             |
| `collection_selection_readback`               | selectable, 2 distinct pairs               | Persisted subset, buy/package/product identity                 |
| `collection_default_materialization_readback` | any, 1 pair                                | Persisted materialized default and identities                  |

Fixed means `collection_targeting_allowed` is omitted or literally false; null
is schema-invalid. One local and one external pair suffice for cross-publisher
subset coverage. A one-pair default or fixed-restatement product never needs a
two-pair companion. Cross-publisher is structural: the retained collection domain
lies outside **all** singular publisher-property domains of the same product.
It attests neither beneficial ownership, AOR, host authorization nor supply-path
verification. The historical carriage filename is retained for continuity.

The six core scenarios require creation, not an optional reader. Only the two
read companions have the root `get_media_buys` tool gate. The gate is any-of by
existing contract, so the root list contains only that reader. An advertised
broken reader fails. An absent reader returns the actual native missing-tool
gate; it does not turn an authored skip into a pass. The repository's standalone
caller executes this same native root gate because SDK16.3's bare standalone
entry does not apply enclosing storyboard gates. Observed profile tools are
bound to the native `agentTools` inventory so a stale caller cache cannot bypass
it. Evaluator disposition, required-phase floors and global skip rules are unchanged.

## Selection, construction and evidence

Product and price declarations use only `discover`, never seed fallback. Account
setup remains in the existing sandbox controller contract. The discovery path
exhausts pagination and validates pages before selecting by deterministic order;
a later qualifying product wins over an earlier nonqualifying one. A complete
valid no-match is an explicit `fixture_unsatisfied` gap, projected
`not_applicable`: feature **not tested**, never a pass or proof of nonsupport.
Fixture catalog transport, protocol, schema, malformed/repeated-cursor and capture
errors remain failed. Native capability-discovery delegation has its separately
disclosed [SDK #3392](https://github.com/adcontextprotocol/adcp-client/issues/3392) limit. Missing controller/account setup has its existing distinct disposition.

The protected selected graph supplies `declared_selectors`, `strict_subset`, the
two collision-checked `undeclared_*` selector arrays, structural relation and
selected product ID. Negatives use the complete selected product, including the
retained external relation when required. ID identity is the exact
(domain, collection ID) pair: legal empty/Unicode IDs, grouping, order and catalog
redundancy do not change comparison. The caller projects distinct canonical wire
entries using the public normalizer; it never rewrites protected raw captures.
An authorization-style domain-only selector is used only in the explicit
schema-invalid negative, whose domain comes from the retained relation.

Whole `snapshot: selected_entity` pricing preserves absent minimum, explicit0 and 5000. The caller constructs budget `max(1000, min_spend_per_package ?? 0)` from
that SAME price; 1000 is buyer test intent, not a fabricated seller term. The
request has no invented top-level currency or auction bid. Required schema,
exact package cardinality, explicit product-ID echo and exact collection-set
checks remain independent assertions. Unknown references require
`REFERENCE_NOT_FOUND`, malformed bulk-form requires `INVALID_REQUEST`, and fixed
bundle narrowing requires `UNSUPPORTED_FEATURE` under the existing schemas.

Full runs prepare once, then consume the authenticated state with invocation-local
lookup authority. Caller-supplied host authorizers still fail closed before HTTP
until [SDK #3389](https://github.com/adcontextprotocol/adcp-client/issues/3389);
the caller does not claim an uncallable hook ran. Denials stay typed exceptions
with private audit records. The invocation grant is closed in `finally` and no
portable or cross-request grant service is claimed.

Read companions consume committed selectors and product ID only after create
passes its protected-witness assertion in a full run. SDK16.3 publishes step
captures before final validation, so failed-step context is not proof of a
successful commitment and must not be reused as trusted standalone history.
Reads compare that committed set rather than later catalog composition.
The caller issues an integrity-only HMAC commitment after the actual standalone
create passes. Its closed claims bind the exact authored storyboard, seller,
AdCP version, authored sandbox account, buy/package/product identities and
normalized concrete pair set. It uses a purpose-separated key derived from the
existing hosted context deployment-secret sources, or a process-private random
key for local development; no public signing API or durable grant store is added.
JSON context round-trips retain the proof, but modified identities/selectors or a
failed create cannot acquire one. This proof grants no seller access: fresh
preparation and all SDK authorization still run on each invocation. Hosted
opaque-reference handoff seals the pre-call continuation on failure/skips while
retaining the failed result's raw captures, validations and ordinary response.
Standalone reads require that successful-create proof and its buy,
package, product and concrete committed-selector context before preparation and
on **every** native discovery-error/malformed-profile fallback;
missing keys are local invocation errors, not fabricated seller failures. This
also prevents generic branch-safe absent-comparand behavior from certifying a
missing identity. Standalone currently requalifies the catalog; retirement of a
previously selected product is not handled as durable prepared-state reuse.

## Executable qualification and bounded SDK gaps

`npm run test:optional-product-collections` executes the actual eight YAMLs via
the public SDK MCP transport and production caller, with controlled HTTP and
seller-owned synthetic catalogs. It covers supporting/nonsupporting/independently
supporting catalogs, omitted/false fixed flags, one/two-pair separation,
later-page selection, same-parent commercial terms, optional minima, legal set
variations, collision controls, invalid catalogs, broken echoes/identities,
negative rejection codes, readback, root gates, private audit and zero-contact
host-hook refusal. The fake seller uses a separate domain-qualified set oracle,
so the production normalizer is not its own expected-answer implementation.
Actual reference-CI rows must be inspected separately; a fixture gap is not
native positive-path evidence.

The following repaired-behavior probes are intentionally **not** passing CI
regressions. Run them manually from the repository root; each fails naturally on
SDK16.3.0. Their original failing assertions are retained, not changed into
success-by-observing-a-defect:

| Public probe                                                                       | Actual SDK16.3 result and qualification limit                                                                                                                                                                                                                |
| ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `node specs/optional-product-collection-qualification/sdk3395-resource-status.cjs` | Explicit lifecycle control passes; omitting optional `media_buy_status` falsely fails later active read. [SDK #3395](https://github.com/adcontextprotocol/adcp-client/issues/3395). The optional field remains optional.                                     |
| `node specs/optional-product-collection-qualification/sdk3396-context-key.cjs`     | Widened subset correctly fails, but failed output omits authored `context_key`. [SDK #3396](https://github.com/adcontextprotocol/adcp-client/issues/3396). The merged output MUST remains in force; this metadata path is unqualified.                       |
| `node specs/optional-product-collection-qualification/sdk3397-feed-restart.cjs`    | Feed changes v1→v2 between pages; resolver makes two page calls and resolves instead of restarting and making four after stabilization. [SDK #3397](https://github.com/adcontextprotocol/adcp-client/issues/3397). Mutable-feed restart remains unqualified. |

The first split matrix was75pass/6fail: four assertions mistakenly classified a
conforming feed-token change as seller failure, and two exposed the genuine
context-key omission. Protocol review corrected the former using the existing
get_products buyer-restart MUST; invalid `adcp_version` is now a separate true
schema-failure case. The latter's unchanged normative assertion is preserved in
the public probe. Initial minimized feed/status drafts with incorrect tool
profile/raw output key were setup errors; corrected probes exercise actual wire
behavior. These historical diagnostics are not final qualification counts.

Only native wholesale sandbox, non-guaranteed fixed-price CPM support is tested.
Guaranteed, auction-priced, brief-only and seeded-only support is not tested.
Bare `comply()` and the scheduled heartbeat lack this caller's selector/budget
projection ([SDK #3382](https://github.com/adcontextprotocol/adcp-client/issues/3382));
no heterogeneous bundle-branding parity is claimed. Hosted cards cannot yet
separate absent offerings from untested fixture slices
([#8416](https://github.com/adcontextprotocol/adcp/issues/8416)). These disclosed
limits do not waive broken selected-path failures or establish seller nonsupport.
