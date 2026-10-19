# #8254 format sort and population qualification on SDK 15.9.5

Status: read-only independent feasibility evidence. No source, SDK, DSL,
dependency, fixture contract, grading policy or existing test was changed.
This does not qualify the held reporting draft for merge. The SDK implementation
owner remains **unconfirmed**; this analysis assigns no implementation work.

## Result

The concern needs to be split:

1. **A returned bounded pair's row order is expressible using existing YAML and
   public SDK behavior.** It is a downstream storyboard coverage opportunity,
   not proof that a new SDK sort validator is prerequisite to all sort coverage.
2. **Correct choice from a hidden larger population is not observable from that
   pair.** An earlier independent GET is not a safe population oracle: legitimate
   nonfinal observations can change between reads. A new comparator alone would
   not establish the missing oracle.
3. **The executable YAML construction has a standalone phase-flow limitation.**
   Public `runStoryboardStep` executes a named step without evaluating its
   enclosing `phase.skip_if`; automatic full/standalone equivalence for legal
   zero/one-row responses therefore is not established by the construction.
   Preserve that qualification hold, rather than silently requiring two rows.

## Executable reproduction

```bash
node --test --test-timeout=30000 specs/optional-product-feature-applicability/format-sort-authorability.test.cjs
```

**15 tests pass** on the installed **15.9.5** package. Tests call public
`runStoryboard`, `runStoryboardStep`, `parseStoryboard` and `loadStoryboardFile`.
They use real MCP initialization/tool dispatch/schema validation through the
public `transport.trustedFetchFn` option. There is no `_client`, `_profile`,
private SDK import, network write or source mutation. The package-version read
is the sole direct non-exported package-file read.

The experiments clone a byte-identical saved snapshot (reporting draft head `8ccc1d62194b9b8e2a9b8d3b2543b20d145f67f6`, under `reporting-snapshots/`) of the actual held `advanced_delivery_reporting` delivery
step, retaining its report schema, requested buy/package joins, narrowing,
format metadata and array-bound assertions. They change the local copy's limit
to two (or a declared population-read limit) and isolate it from account,
discovery and buy setup. Thus they establish sort-authoring behavior beginning
with an already-selected/created buy, **not** repaired applicability or complete
source execution. Existing 48-test draft counterexamples remain untouched.

## Existing-contract bounded same-read construction

`core/protocol-envelope.json` defines caller-owned `context` as opaque custom
metadata that the agent MUST preserve unchanged. `core/context.json` accepts
arbitrary object properties. No new echo task or seller field is proposed.

The existing YAML primitives can perform this bounded check:

1. Read one report with `reporting_dimensions.format: {limit: 2, sort_by: spend,
   sort_direction: asc}`. Preserve the current required metadata/limit checks.
   Capture the whole returned `by_format` array into one context key. Empty is
   an available array value and does not cause a missing-capture failure.
2. In a full-run phase with `skip_if: '!context.observed_rows.1'`, run the
   comparison only if the same snapshot actually has a second row. This uses
   row presence, not spend truthiness; zero spend and ties are valid.
3. Call existing `get_adcp_capabilities` with that captured array in opaque
   request context. Require `field_equals_context` on the echoed array, then
   capture its first and second spend as top-level numeric keys.
4. Call `get_adcp_capabilities` with those scalars in context. Require both
   scalar echoes to equal their saved values and use `field_at_most` to compare
   the first echoed scalar with the saved second scalar.

All numerical inputs originate from **one** report response. The extra two
tool calls only echo caller-owned frozen values; they do not read delivery
again. An agent cannot repair an unsorted pair by altering the echo: exact
array/scalar equality checks fail. The target must support the ordinary
capability tool and its existing context-echo obligation.

This is a feasibility construction, not a recommendation to ship these extra
calls without product/protocol/code review. It is more cumbersome than a shared
same-response sorted-array validator. It proves that the general statement
“existing YAML cannot grade returned row order” is too broad.

For `limit: 2`, at most one adjacent comparison is required. It does not claim
an unbounded iteration/transform capability or complete coverage of every
possible format row. Numeric checking uses actual returned spend, not invented
observations or hardcoded expected amounts. Legal empty/one-row full runs skip
the inapplicable pair assertion, while keeping the ordinary metadata, shape,
limit and request-identity checks active.

## Observed outcomes

| Public experiment | Observation |
| --- | --- |
| Sorted, tied, zero-spend and fractional-spend returned pairs | Pass the real numeric check. |
| Descending `[20, 10]` under ascending metadata | Fails `field_at_most`, using one delivery read only. |
| Valid empty array / one returned row | Full run remains valid and omits the gated comparison steps. |
| Seller sorts an unsorted snapshot during its echo | Exact echo validation fails; tampering cannot authorize a pass. |
| Three rows returned under requested limit two | Existing source `array_length` bound fails. |
| Ordered `[10, 20]` returned while the hidden population is `[5, 10, 20]` | Passes: order and size do not prove correct population selection. |
| Full public steps versus manually threaded standalone steps with two rows | Both pass sorted pairs and fail descending pairs. |
| Direct standalone capture step after a valid empty/one-row report | Ignores the enclosing `skip_if`; fails `capture_path_not_resolvable`. Full-run skip behavior is not automatically reproduced. |

## Why simpler numeric YAML attempts do not establish the same result

- `context_outputs` extraction occurs **after** a step's validations. A numeric
  check referencing a scalar authored as that same step's output sees an absent
  comparand. Existing branch-safe numeric semantics record
  `context_key_absent` and pass, even for a descending pair. The evidence checks
  this exact false pass.
- A taskless validation-only follow-up is normalized to `__validation_only__`
  and skipped as `fixture_unavailable`; it does not evaluate captured response
  data locally.
- Phase `skip_if` supports truthiness, equality and boolean/string OR, not numeric
  `<`/`<=` comparison. The public loader rejects a numeric-order expression.
- `any_of` checks accumulated contribution flags. It does not evaluate a numeric
  expression or a nested group of ordinary validations.
- The public `refs_resolve` membership check is not numerical ordering or
  top-K selection. Cross-response equality/count checks describe parallel
  dispatch results, not an immutable delivery snapshot or a same-response sort.

These are actual current mechanisms, not proposed API extensions.

## Population selection counterexamples

A naïve test can read a broad population, capture its first spend/kind, then
request limit one and demand the same result. The public probes show:

- Stable population `[5, 10, 20]`, later limit-one result `[5]`: passes.
- Stable population `[5, 10, 20]`, incorrect later limit-one result `[10]`:
  correctly fails.
- First population `[5, 10, 20]`, later **truthful changed** population
  `[8, 9, 21]` with its correct limit-one result `[8]`: also fails.

Both requests have the same reporting period and valid nonfinal report shape.
The ordinary dimensional GET contract does not bind them to one immutable
observation. `is_final: false` explicitly admits unfinished/maturing data.
Requesting a limit does not freeze the first read, and opaque echoed context
freezes caller-supplied evidence only, not a later seller observation.

Replacing best-row equality with `refs_resolve` against the earlier full array
does not solve this: a stable wrong best `[10]` is still a member and passes;
a legal updated metric value no longer matches the prior row and falsely fails.

An exact `reporting_revision_id` read is a separately bound Reliable Reporting
surface, mutually exclusive with dimensional/metric selectors. It is not an
existing promise that two ordinary `reporting_dimensions.format` reads share
one population. Do not use it as that promise without an applicable contract.
The current `simulate_delivery` totals do not identify a deterministic
format-grain population either.

## Recommended downstream versus shared-foundation scope

- Keep sort order/limit/selection normative obligations distinct from the
  availability of their test oracle. No optional feature failure becomes a
  blanket skip, and no new support declaration is needed for returned-row sort.
- Record bounded **same-response returned-row order** as a downstream source
  improvement that can be authored today for full runs. The evidence provides a
  public-API construction rather than presuming a missing SDK primitive.
- Do not ship a sort-source rewrite until empty/one-row standalone behavior and
  caller orchestration are explicitly qualified. A direct standalone invocation
  currently does not apply enclosing phase flow. Whether to fix that in common
  runner behavior or orchestrate it at an existing entry point needs scoped
  review; it is not evidence of a numeric-validator requirement by itself.
- A shared same-response array-order validator would be a convenience and could
  reduce calls/complexity, or be needed for broader arbitrary-length validation.
  It does **not** supply a hidden population oracle or automatically fix
  standalone preparation/flow. Its design/ownership must be confirmed before
  assigning or implementing it.
- Correct top/bottom-K population selection needs independently trustworthy
  evidence applicable to the **same observation**. Current generic totals and
  independent live GETs do not provide it. Keep this limit explicit; a new
  deterministic-grain controller contract or snapshot-bound dimensional query
  would be separate reviewed work, not an assumption in this patch.
- Preserve every existing draft hold: selected minimum-spend/commercial state,
  matured time commitment/disclosure, caller-brand plumbing, fixture-state
  standalone parity and exact hosted discovery disposition. None is solved or
  weakened by these experiments. No current source is declared shippable.
