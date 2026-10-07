# Shared SDK persistence contracts

**Status:** Proposal for review; no new protocol requirements or storage compatibility claims.
**Date:** 2026-10-07
**Scope:** Official JavaScript and Python SDKs, starting with reporting and idempotency.

## Recommendation

Create a language-neutral persistence package containing canonical record
contracts, PostgreSQL migrations, Redis key/value contracts and scripts, and
shared conformance fixtures. Both SDKs consume pinned releases of these assets.
Their public APIs and database drivers remain native to each language.

Start the source in a dedicated `persistence/` directory in this repository.
Version and release its artifacts independently of SDK releases. A separate
repository can follow if ownership or release operations warrant it; repository
creation is not a prerequisite for agreeing on the contracts.

Keep a versioned reporting archive as the explicit migration/export path for
existing installations. Converge new installations on
one physical PostgreSQL layout per supported component. Qualify switching SDKs
against that layout before claiming compatibility. Qualify concurrent writers
separately.

## Problem and evidence

The SDKs implement the same protocol but currently define their own durable
storage. Differences extend beyond naming:

| Surface | JavaScript SDK | Python SDK | Consequence |
| --- | --- | --- | --- |
| Reporting ledger | `adcp_reporting_*`, retained native JSONB records plus indexed columns | `reporting_*`, normalized records and separate row storage | Renaming tables does not permit switching SDKs. |
| PostgreSQL idempotency | `adcp_idempotency`, one `scoped_key`, explicit retention horizon | `adcp_idempotency`, `(scope_key, key)`, different retained columns | The same table name already describes incompatible layouts. |
| Idempotency coordination | Durable claims and owner-fenced transitions | Execution locks around lookup, handler execution and cache commit | Common columns alone would not align crash recovery. |

These observations refer to JavaScript snapshot `68614aa0` and Python snapshot
`a5d56a68`. Implementation references:
[JS reporting](https://github.com/adcontextprotocol/adcp-client/blob/68614aa0ce84046c78d76dda9721ffbf9328639a/src/lib/reporting/ledger/postgres.ts),
[Python reporting](https://github.com/adcontextprotocol/adcp-client-python/blob/a5d56a683661a79d76861ea6d1043a3aceda77f8/src/adcp/reporting/ledger/reporting_ledger.sql),
[JS idempotency](https://github.com/adcontextprotocol/adcp-client/blob/68614aa0ce84046c78d76dda9721ffbf9328639a/src/lib/server/idempotency/backends/pg.ts),
[JS claim coordination](https://github.com/adcontextprotocol/adcp-client/blob/68614aa0ce84046c78d76dda9721ffbf9328639a/src/lib/server/idempotency/store.ts),
[Python idempotency](https://github.com/adcontextprotocol/adcp-client-python/blob/a5d56a683661a79d76861ea6d1043a3aceda77f8/src/adcp/server/idempotency/backends.py).

Language differences justify different object models, async APIs and drivers.
They do not require different durable identities, evidence encodings, expiry
rules or transaction semantics. Separate implementations need one executable
contract to prevent those differences from accumulating.

## Ownership and boundaries

| Owner | Responsibility |
| --- | --- |
| Shared persistence package | Canonical records, backend layouts, migrations, atomic operations, compatibility manifest and conformance fixtures |
| Each SDK | Driver integration, native APIs, record projection, transaction participation and contract enforcement |
| Deployment operator | Run approved migrations once, select deployment namespace, coordinate cutover and retain recovery material |

JavaScript can provide the first migration CLI. Its SDK is not the schema
authority. Python also needs an administrative runner using the same SQL assets;
a Python deployment should not require the JS SDK to manage its database.
Reviewed migration tools may apply the same assets directly.

For each component, require review from both SDK maintainers. Changes to protocol
semantics follow the protocol's existing governance and release process. This
package specifies reference SDK persistence, not a mandatory database technology
for every AdCP implementation. Custom stores can implement the semantic contract
without adopting the reference PostgreSQL or Redis layout.

Shared storage covers evidence and state that affect future behavior: accepted
configuration generations, obligations, revisions and rows, adjustments,
consumer history, idempotency records, and eventually durable worker and delivery
state. Local object caches, connection pools and logging remain implementation
details. Durable extensions get explicit namespaces and compatibility declarations;
they cannot silently become language-specific requirements for reading shared data.

## Package contents and release model

The following is a proposed source layout, not an existing package:

```text
persistence/
  manifest.json
  contracts/
    reporting-core/
    idempotency/
  postgres/
    reporting-core/migrations/
    idempotency/migrations/
  redis/
    idempotency/
  fixtures/
  conformance/
```

Publish immutable archives containing these assets and checksums. npm and Python
distributions can bundle the same bytes. SDKs pin exact artifact releases and
operate from local assets; startup and migration do not fetch a mutable latest
definition from the network.

Track protocol version, persistence contract version, component migration
revision and SDK version separately. The manifest records each component's
dependencies, supported read/write contracts, installed features and asset
checksums. SDK releases declare which combinations they support. A reporting
upgrade should not require an unrelated idempotency migration.

Use one migration history table in the selected PostgreSQL namespace, with
component, revision, checksum and application time. Apply migrations under a
shared deployment migration lock. Previously applied revisions are immutable.
Transactional migrations roll back on failure; any required nontransactional
operation needs a separately specified, resumable procedure.

Production migration is an explicit administrative action. Runtime SDKs inspect
compatibility and refuse incompatible access rather than inventing their own
DDL. Existing bootstrap helpers can wrap the shared runner to preserve APIs.
Read-only participants need no DDL permissions. Use additive upgrades first,
and document supported old/new readers and writers before allowing overlap.

## Shared backend contracts

### Reporting PostgreSQL

Use a common `adcp_` prefix for new reference tables, with a deployment-selected
PostgreSQL namespace. Both SDKs receive the same namespace configuration.
Legacy names remain migration inputs, not aliases that permit old writers to
continue against a new layout.

Prefer explicit identity, relationship and scheduling columns, with JSONB for
extensible evidence payloads. Neither SDK's complete native object graph becomes
the persisted canonical record. If evidence fields are projected into indexed
columns, specify how writes enforce agreement with the retained payload.

The contract defines account-qualified references and exact identifier equality,
row order, frozen definition/schema bindings, coverage, currency and units,
finality, and supersession. Consumer statement identity includes its account and
authenticated principal. Preserve stronger uniqueness where the protocol requires
it; do not rename existing IDs to fit a narrower implementation key.

Specify timestamp precision, numeric ranges, exact decimal representation and
canonicalization explicitly. Migration preserves existing content digests and
evidence values; changing a decimal, rounding a timestamp or coercing a row
number to make it importable is not a migration. Unsupported evidence causes a
checked refusal. The archive retains original producer metadata until an
explicit source-binding conversion is available.

### Idempotency PostgreSQL and Redis

Agree on the semantic state machine before finalizing the physical layout.
It covers deployment/tenant/principal scope, account binding where required,
operation binding, canonical request hashing and its exclusion rules, cached
response representation, claim ownership, completion, conflicts, recovery and
retention. Where the protocol requires a reused key on another tool to conflict,
bind the tool in the request fingerprint rather than giving it a separate slot
that avoids the conflict. Specify extra scope only for operations whose protocol
semantics permit it; do not silently change key scope during language migration.

Represent request fingerprints separately from owner tokens and lease
generations. Specify atomic claim, renewal, completion and release operations,
including rejection of a stale owner. An expired handler lease does not prove
that a side effect did not commit. Ambiguous outcomes require reconciliation
before execution can resume. Keep cached outcomes independent of resource
deletion for the applicable replay window, and define logical expiry separately
from physical pruning.

These contracts implement the applicable
[security and idempotency rules](../docs/building/by-layer/L1/security.mdx).
[DR-0021](../governance/decisions/DR-0021-idempotency-ledger-outlives-resource.md)
provides related rationale but is currently marked proposed; this proposal does
not ratify it or introduce new wire errors.

PostgreSQL gets one shared DDL and operation contract. Redis gets versioned,
unambiguous key encoding, value schemas, authoritative clock rules, retention
rules and shared Lua scripts. Define cluster key placement for multi-key
operations. A backend format version is deployment/component-specific, not
language-specific; changing versions requires an explicit transition that
preserves live claims rather than making existing keys disappear.

Qualify the backend's configured durability as well as its record format. A
Redis deployment that cannot retain outcomes for the declared replay window
does not qualify merely because it runs the shared scripts.

PostgreSQL and Redis implement the same observable semantics with different
physical storage. This does not imply that moving live idempotency state between
backends is automatically supported. Nor can the store alone guarantee atomicity
with arbitrary external side effects: same-database operations need documented
transaction participation, and external operations need durable downstream
deduplication or reconciliation.

## Adoption plan

| Stage | Deliverable | Acceptance gate |
| --- | --- | --- |
| 0. Inventory and contracts | Field/state comparison for both SDKs, component boundaries, manifest, preservation/refusal rules and shared fixtures | Both SDK maintainers agree on semantics and identify every unmapped durable field. |
| 1. Reporting Core | Canonical PostgreSQL layout, immutable migrations, administrative runners and adapters in both SDKs | JS and Python write, read and perform supported sequential handoff against the same database. |
| 2. Existing installations | Explicit migrations from both legacy layouts into the canonical layout; retained archive and cutover runbook | Evidence readback, rollback and exact retry pass against real legacy stores. |
| 3. Idempotency | Shared state machine, PostgreSQL operations, Redis format/scripts and SDK integration | Mixed-language retries, contention, stale-owner and crash-recovery cases pass for each backend. |
| 4. Operational extensions | Managed delivery, receipts/batches, notifications/outboxes, replay protection and durable producer scheduling | Each extension qualifies separately, with installed-feature checks preventing unsupported participation. |

Keep each stage in small PRs: contract/assets first, one SDK adapter per PR,
then the shared qualification gate and migration tooling. Do not advertise a
component as interoperable until both adapters and its storage tests are released.

The initial archive route has a narrower scope: TypeScript PostgreSQL Core
evidence to Python's existing layout. Its initial scope excludes managed delivery,
operational checkpoints and pending claims. Stage 2 adds distinct
legacy-to-canonical migrations without expanding the initial archive's
compatibility promise.

For legacy cutover, stop writers and drain or explicitly preserve outstanding
work, export a consistent account snapshot, preflight it, migrate atomically into
an empty destination, and verify readback before resuming. Keep the source for
recovery. After destination writes begin, reverting requires reconciling those
writes; switching back to a stale source is not a safe rollback. Checkpoints and
in-flight state transfer only when their component has a specified conversion.

## Qualification and compatibility claims

Run both adapters against the same real backend namespace in CI. Tests using
separate SDK databases establish wire interoperability, not shared persistence.

The qualification suite covers both write/read directions, sequential SDK
handoff, account isolation, identical-ID replay, conflicting-content refusal,
zero rows versus missing reports, typed totals, Unicode canonicalization,
historical supersession and readback of original digests. Migration tests cover
failed imports, retry, occupied destinations, unknown versions and unsupported
evidence without partial destination state.

Idempotency qualification includes a completed JS request replayed by Python
and the reverse; simultaneous attempts with the same and different payloads;
stale-owner publication; lease expiry during an ambiguous outcome; deletion of
the affected resource; logical/physical expiry boundaries; and failure between
business commit and response publication. Inspect durable outcomes as well as
responses. Redis tests exercise the real scripts, restart/recovery behavior and
supported cluster topology.

Publish a compatibility matrix per component and artifact version distinguishing
export/import, sequential handoff and concurrent mixed-SDK participation.
Concurrent writers require shared locks/fencing and dedicated tests. An SDK that
does not understand an installed behavioral extension refuses participation in
affected work. The same table layout alone is not a compatibility declaration.

## Alternatives and tradeoffs

Making the JS SDK the sole schema manager gives a fast initial implementation
but ties Python deployments to its release cadence and runtime. A shared asset
package retains that initial tooling option without assigning permanent ownership
to one language.

Keeping export-only interoperability minimizes immediate adapter changes but
leaves every future language switch as a migration and permits storage semantics
to drift. Matching table names while retaining separate layouts does not address
that drift. Forking SQL/scripts into each SDK also leaves two editable authorities;
bundled copies should be checksum-verified outputs of one artifact release.

Shared contracts introduce coordination cost: both SDKs need to participate in
format changes, and deployments need a compatibility check and upgrade procedure.
Component releases, explicit support matrices and staged migration contain that
cost while preserving independently released language APIs.

## Decisions for review

The recommended decisions are shared package ownership, source initially in this
repository, independently versioned component artifacts, explicit production
migrations, and Reporting Core as the first common layout. JS can implement the
first CLI; both SDKs need independent administrative access to the same assets.

Before implementation, settle the exact Core DDL and field mapping, supported
backend versions/topologies, and the idempotency state-machine differences.
Neither existing SDK automatically wins those decisions. Changes to protocol
semantics are separate from choosing a reference persistence layout.
