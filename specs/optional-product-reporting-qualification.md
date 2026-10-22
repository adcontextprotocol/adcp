# Catalog delivery reporting qualification for #8254

This patch separates format breakdown (`advanced_delivery_reporting`) and
`time_based_views` (`time_based_delivery_reporting`) into independent catalog
scopes. It is a partial correction for [#8254](https://github.com/adcontextprotocol/adcp/issues/8254),
which remains open for collection paths. No declaration fields or controller
refusal semantics are introduced.

## Applicability and commercial identity

Both scopes fully paginate schema-valid wholesale discovery and resolve a
seller-owned sandbox product with a scoped fixed-CPM price. An earlier unusable
product cannot hide a qualifying later product. A completed no-match is an
explicit `fixture_unsatisfied` coverage gap projected `not_applicable`; discovery,
schema, protocol and pagination errors retain failed evidence. Neither seeding
nor the wholesale/controller/tool gates establish native optional support.

Repository full and standalone callers use `prepareStoryboardFixtures` once,
capture the SAME selected price with `snapshot: selected_entity`, and reuse its
protected bindings through `withPreparedFixtures`. The caller derives its buyer
budget as `max(1000, declared minimum when present)`, and takes currency from the
same selected price. The immutable snapshot preserves absent, explicit zero and
5000 minima distinctly. No fixed price is misrepresented as an auction bid.
The adapter excludes the unrelated legacy first-product cache from these two
scopes to prevent the SDK's generic auction-bid heuristic from using another
product. Root `catalog_reporting_budget: 1000` is explicit buyer intent, not a
seller minimum; external callers must perform the same preparation/derivation.

The adapter scopes preparation to one seller and one authenticated invocation,
uses trusted authored sandbox identity, and rejects caller attempts to disable
sandbox scope or substitute supplied prepared state. Reserved caller maps are
rejected by the SDK before capability discovery. Every consumer lookup still
uses the SDK authorizer, with an optional host hook remaining authoritative.
Request-local state is never serialized or reused across unrelated callers.
Typed authorization denials remain denials, never seller conformance failures;
when configured, only the caller's private audit sink receives linked producer
fixture records alongside the unchanged consumer result/evidence/accounting.

## Resolution of the former holds

| Former hold | Current disposition |
| --- | --- |
| Minimum 5000 rejected by budget 1000 | Full and standalone caller adapter derives a valid budget from the exact selected price snapshot. Absent/0/5000 and real currency covered publicly. |
| Standalone has no fixture bindings | Both actual hosted standalone callers and training/full callers use explicit public preparation and authorized state reuse. Cross-invocation continuation remains a separate host requirement. |
| Brand overwritten with `test.example` | Repository adapter supplies trusted authored brand; bare-SDK behavior is reproduced and tracked in [SDK #3381](https://github.com/adcontextprotocol/adcp-client/issues/3381). |
| Discovery error projected `setup_gap` | Merged SDK emits discovery's actual task; unchanged hosted classifier now projects `failed`. Raw failures are retained. |
| Mature committed metric and disclosure both disappear | General eligibility cannot be faithfully derived by existing closed assertions/controller guarantees. Concrete protocol follow-up [#8412](https://github.com/adcontextprotocol/adcp/issues/8412); disclosed coverage gap, not claimed qualification. |
| One-row format sort | Checks applied sort metadata and limits; does not establish hidden population or multi-row ordering. Disclosed scope. |

The bounded reporting assertions retain required arrays/metadata, exact buy and
package identity, requested-metric narrowing, accepted injected totals and legal
seller-defined thresholds/bases. They do not demand a first threshold of 2,
`play_time`, `video_hosted`, true truncation or nonempty unguaranteed observations.
Missing companion fixtures do not suppress a supported scope. Baseline metric
narrowing remains independently graded; no required-phase or step floor changes.

## Integration limits

- Native discovery only: seeded-only/brief-only/auction-only offers and incompatible
  delivery/pricing combinations remain explicit coverage gaps, never nonsupport.
- `comply()` rejects prepared state and lacks per-storyboard prepared commercial
  options ([SDK #3382](https://github.com/adcontextprotocol/adcp-client/issues/3382)).
  The repository adapter does not establish heterogeneous bundle parity.
- An Addie `context_ref` is ordinary encrypted JSON, not SDK preparation authority.
  Each standalone invocation prepares afresh; a pinned multi-click graph needs a
  host-owned live grant/state store. The adapter does not add such a service.
- Socket Mode connected-client reuse with an explicit protocol version falls back
  to its synthetic URL instead of the connected client
  ([SDK #3383](https://github.com/adcontextprotocol/adcp-client/issues/3383));
  HTTP caller qualification does not qualify that path.
- Hosted history retains the raw SDK pass boolean and has no separate incomplete
  fixture-coverage status ([#8416](https://github.com/adcontextprotocol/adcp/issues/8416)).
  Addie displays incomplete/not-applicable gaps explicitly without changing stored
  booleans, grading or floors.
- Direct SDK users need matching `options.brand` and a derived budget. The YAML
  alone cannot express arithmetic or nested snapshot request substitution.
- Public probes use controlled synthetic seller credentials and local intercepted
  MCP transport. They are not production writes or a seller-wide support claim.

## Evidence and release boundary

Development uses an isolated pack of merged SDK foundation commit
`37d308768b01b99f4650800d5af7cfc051b40e9e`. Its source package version 16.2.0
must not be confused with npm 16.2.0 at pre-foundation `7d2822f0`. Final dependency
qualification awaits the actual published foundation version; local results do
not establish that npm release identity.

Executable regressions run the ACTUAL revised YAMLs, production caller adapter,
public SDK MCP transport and hosted classifier. They cover no support,
independently supported paths, later catalog pages, advertised-but-broken fields,
metric narrowing, legal reporting variations, minimum absent/0/5000, sandbox
identity, refusal before seller contact and wholesale/controller gates. Raw
counterexamples for the disclosed maturity and bare-SDK branding gaps remain
explicit observations, not repaired-behavior passes.

Current merged-foundation public catalog comparison (actual source and adapter):

| Native catalog | Format scope passed/failed/skipped | Time scope passed/failed/skipped |
| --- | --- | --- |
| Neither feature | 0/0/0 + explicit coverage gap | 0/0/0 + explicit coverage gap |
| Format only | 3/0/0 | 0/0/0 + explicit coverage gap |
| Time only | 0/0/0 + explicit coverage gap | 3/0/0 |
| Both | 3/0/0 | 3/0/0 |

The real training per-ID entry runs likewise find no qualifying native fixture,
print each `fixture_unsatisfied` detail and execute zero reporting rows. The CLI's
existing clean count means no failed rows, not support qualification. Preparation
runs separately and contributes no synthetic seller pass here. Addie reports
these gaps as incomplete/not applicable. No floor or raw-result accounting changed.

Historical SDK15.9.5 and candidate4f3a098 evidence remains separately preserved.
Its counts do not qualify the merged foundation. Historical original-vs-split
comparison at `c2f01a50` observed raw passed/failed/skipped counts of 3/1/3 for
nonsupporting original combined scope versus 1/0/1 per new coverage-gap scope;
legal both-feature data gave original 6/1/0 versus split 6/0/0 each. These are
bounded historical comparisons, not new exact-head CI or synthetic seller passes.

Main first. A separately reviewed 3.2.x backport requires faithful qualification
against its actual pinned SDK and schema; main evidence is not transferable.
A maintenance source merge may refresh draft Version Packages #8274 through
Changesets. That effect remains separately held; #8302-only permission does not
extend here. No release, publication, Version Packages mutation, immutable
artifact change or maintenance merge is part of this PR.
