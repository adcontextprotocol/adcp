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
explicit `fixture_unsatisfied` coverage gap projected `not_applicable`; fixture discovery,
schema, protocol and pagination errors retain failed evidence. Neither seeding
nor the wholesale/controller/tool gates establish native optional support.

Repository full and standalone callers use `prepareStoryboardFixtures` once,
capture the SAME selected price with `snapshot: selected_entity`, and reuse its
protected bindings through `withPreparedFixtures`. The caller derives its buyer
budget as `max(1000, declared minimum when present)`, and retains currency from the
same selected price for diagnostics. The create request has no top-level currency;
its selected pricing option determines the commercial currency. The immutable snapshot preserves absent, explicit zero and
5000 minima distinctly. No fixed price is misrepresented as an auction bid.
The adapter excludes the unrelated legacy first-product cache from these two
scopes to prevent the SDK's generic auction-bid heuristic from using another
product. Root `catalog_reporting_budget: 1000` is explicit buyer intent, not a
seller minimum; external callers must perform the same preparation/derivation.

The adapter scopes preparation to one seller and one authenticated invocation,
uses trusted authored sandbox identity, and rejects caller attempts to disable
sandbox scope or substitute supplied prepared state. Reserved caller maps are
rejected by the SDK before capability discovery. Every consumer lookup still
uses the invocation-local SDK authorizer. A supplied host hook currently fails
closed before all seller contact: SDK 16.3 has no public way to construct its
truthful lookup before preparation (#3389). No hook is called with a fabricated
binding or alternate reference. Exact-once pre-preparation invocation remains an
upstream requirement; this refusal is not qualification of that missing API.
SDK 16.5 added `prepared_fixtures_preparation_authorizer` (#3393), consulted
inside `prepareStoryboardFixtures`. The adapter still refuses on SDK
17.0.0-beta.0: its capability preflight contacts the seller before that
preparation, because the SDK's preparation applies no storyboard root gates
before seeding (adcp-client#3435).
Request-local state is never serialized or reused across unrelated callers.
A failed initial/capability preflight delegates the ORIGINAL invocation to the
SDK (`execute(originalOptions)`). The adapter neither throws raw remote text nor
constructs a replacement seller grade. Native discovery/auth diagnostics remain
in the ordinary result for Addie OAuth handling, history, registry and Socket Mode.
Preflight validation uses the same nested external schema root and
`servedReleaseSchemaRoots` scopes as native full/standalone execution.
Some native capability-read failures still become a synthetic partial profile
and a capability skip; these native outcomes are compatibility observations,
not claims that discovery failure is conformant. Initial tools/transport failures
remain native `discovery_failed` results. [SDK #3392](https://github.com/adcontextprotocol/adcp-client/issues/3392) records that boundary.
Typed authorization denials remain denials, never seller conformance failures;
when configured, only the caller's private audit sink receives the refusal
record. The SDK-API-gap refusal precedes preparation and honestly has no resolved
fixture identities or seller exchanges; its request/response are explicitly null.
Sink failures cannot undo denial or leak through its typed error. Registry maps
`PreparedFixturesDeniedError` to HTTP403 with only `code` and `refusal_code`.
Every invocation-local grant closes in `finally`, including errors; concurrent
grants are independent and a late lookup is refused.

Authorized execution results also retain missing `fixture_resolutions` from the
SAME preparation. Failed records carry the original detail and self-contained
producer phase under the existing optional `failure` field. Existing native
records/failures, grades, phases, counters and consumer wire fields are preserved.
On standalone results this is supplemental adapter metadata, not an SDK
`StepResult` API claim. Typed denials never reach this attachment.

The native failed-preparation output still has gaps ([SDK #3385](https://github.com/adcontextprotocol/adcp-client/issues/3385)):
full execution returns a generic blank-task/empty-validation failure row; the
producer phase misattributes discover-only failure to the controller and omits
raw catalog response/schema records. Pagination failure also lacks request
evidence. The adapter retains available original evidence without inventing
missing wire or changing those native rows. This nonblocking upstream follow-up
is not an evidence exemption. Remove the workaround once native full and
standalone results retain equivalent truthful producer evidence.

## Resolution of the former holds

| Former hold | Current disposition |
| --- | --- |
| Minimum 5000 rejected by budget 1000 | Full and standalone caller adapter derives a valid budget from the exact selected price snapshot. Absent/0/5000 and real currency covered publicly. |
| Standalone has no fixture bindings | Both actual hosted standalone callers and training/full callers use explicit public preparation and authorized state reuse. Cross-invocation continuation remains a separate host requirement. |
| Brand overwritten with `test.example` | Repository adapter supplies trusted authored brand; bare-SDK behavior is reproduced and tracked in [SDK #3381](https://github.com/adcontextprotocol/adcp-client/issues/3381). |
| Discovery error projected `setup_gap` | Prepared discovery failures now project `failed` under the unchanged classifier. The adapter links absent producer records; native attribution/raw-wire omissions remain [SDK #3385](https://github.com/adcontextprotocol/adcp-client/issues/3385). |
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

The runtime is pinned to published `@adcp/sdk@16.3.0`, npm `latest` at
qualification, from release commit `765aa8986a93cdab00da873cee47b98f9678bd75`.
Its verified ancestry contains the merged fixture foundation
`37d308768b01b99f4650800d5af7cfc051b40e9e`. Installation uses the registry
artifact and committed lock integrity through ordinary `npm ci`; there is no
local-pack dependency, SDK source shim or custom package-resolution path.
Earlier merged-source development-pack results remain historical evidence;
they do not substitute for the published-package integration checks.

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

## Review delta and follow-up ownership

Hosted Addie full/step and registry step calls have a90-second overall
`AbortSignal`; Socket Mode uses its requested total timeout (default60seconds).
Hosted calls to these two current-source scopes also cap each response at 1 MiB
(or retain an existing tighter cap), using the public SDK transport option. This
is an operational bound, not a protocol product-size rule: an oversized catalog
response is a discovery/budget failure, never fixture_unsatisfied or nonsupport.
Other storyboards and older same-ID artifacts keep their existing transport caps.
The same deadline is composed with per-request signals at the hosted safe-fetch
boundary because some SDK16.3 discovery/controller calls omit their run signal.
This preserves the existing SSRF/network policy and stops later HTTP pages or
mutations after expiry. SDK preparation forwards the signal to catalog calls;
page/aggregate-byte knobs and comprehensive controller cancellation remain
[SDK#3390](https://github.com/adcontextprotocol/adcp-client/issues/3390).
Socket Mode's connected transport does not use safe fetch and remains separately
bounded by SDK signal checks and task timeout, not claimed fully interruptible.
The fixed1000-page SDK safety ceiling is not claimed to be a hosted byte budget.

- Public pre-preparation authorization prerequisite: [SDK#3389](https://github.com/adcontextprotocol/adcp-client/issues/3389).
- Generic caller-side commercial derivation: [SDK#3391](https://github.com/adcontextprotocol/adcp-client/issues/3391); preserves explicit budget/negative-test intent and complements#3381/#3382 rather than replacing them.
- Native reference positive fixtures: [#8425](https://github.com/adcontextprotocol/adcp/issues/8425). Existing reference no-match/zero reporting rows are not feature passes.
- Reviewed3.3 format/time observation injection: [#8426](https://github.com/adcontextprotocol/adcp/issues/8426), following merged#7982 and remaining distinct from#8412 measurability.
- Hosted not-offered versus not-tested presentation/history: [#8416](https://github.com/adcontextprotocol/adcp/issues/8416).

The scheduled `compliance-heartbeat.ts` path still invokes bare `comply()` without
per-storyboard selected-price budget or authored-brand derivation (#3381/#3382).
Repository full/standalone adapter coverage does not establish bundle parity.
New `time_based_delivery_reporting` is introduced in3.3 on main; the historical
format storyboard retains its3.2 introduction. A maintenance backport is separate.
