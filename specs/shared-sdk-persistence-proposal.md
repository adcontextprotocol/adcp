# Shared SDK persistence: canonical reporting layout and pluggable row storage

**Status:** Proposal for review. Reference-SDK persistence only; no new protocol requirements.
**Date:** 2026-10-07
**Scope:** Official JavaScript and Python SDKs. Reporting first, then idempotency.

## Summary

1. **One shared PostgreSQL layout for Reliable Reporting, owned outside either SDK.**
   Both SDKs ship the same `adcp_reporting_*` tables, migrations, lock keys, catalog
   manifests and conformance fixtures from one versioned asset package. Switching
   SDKs, or running both against one database, stops being a data migration.
2. **Revision headers stay in PostgreSQL. Row bytes can live in object storage.** A
   revision header holds identity, finality, supersession, the protocol content binding
   and a digest of its chunk manifest. Rows are canonical JSONL chunks stored in
   PostgreSQL (the default) or in object storage: GCS, S3, Azure Blob, or a local
   filesystem. Every read is verified against digests committed in PostgreSQL.
3. **Warehouses get a derived copy, not the authoritative one.** A *warehouse sink*
   loads committed revisions from the change feed into adopter-defined BigQuery (or
   other warehouse) tables, once per tick. Table names, columns, types, partitioning
   and retention are the adopter's. The sink is never read for serving or
   verification, so it can never break a hash.
4. **PostgreSQL stays the only coordination database.** Locks, leases, gapless revision
   numbering, the change feed and lifecycle compare-and-set need row locks and
   multi-statement transactions. BigQuery and object stores hold bytes; they never run
   the ledger.
5. **Retention is explicit and protocol-aligned.** Superseded snapshots stay readable
   for the advertised `status_retention_days`, as the protocol requires. Every other
   record (headers, change feed, replay rows) has a stated bound. Volume is controlled
   three ways:
   - moving bytes out of PostgreSQL;
   - storing unchanged pulses as header-only revisions that reuse the previous rows, so
     freshness still advances without storing rows again;
   - advertising a retention window that matches what the adopter actually needs.
6. **Hosts get serving-grade reads.** A one-lookup current-revision read per obligation
   and a durable, gap-free change cursor serve pacing, alerts and the warehouse sink.
   None of them read from the warehouse.

## Problem and evidence

The SDKs implement the same protocol but define incompatible durable storage. Both
keep every reporting row in PostgreSQL forever.

| Surface | JavaScript SDK | Python SDK | Consequence |
| --- | --- | --- | --- |
| Table naming | `adcp_reporting_*` | `reporting_*` (newer private tables `adcp_reporting_*`) | Renaming alone does not permit switching SDKs. |
| Record style | Thin indexed columns plus the full domain object in `data JSONB` | Fully columnar; JSONB only for nested values | No shared reader is possible today. |
| Revision rows | Inline in `adcp_reporting_revisions.data` | Separate `reporting_revision_rows(revision_id, ordinal, row_payload JSONB)` | Python already has the header/row split; JS does not. |
| Revision ordering | Gapless `revision_number`, lease-fenced insert | Supersession chain plus partial unique indexes. No root constraint, so two parentless revisions can fork an obligation | Neither constraint set is complete. |
| Work lease | Per obligation, fenced by generation on every write | Per configuration generation; writes carry no fencing token | Different safety models. |
| Account lock key | `hashtextextended('adcp-reporting-account:'‖id, 0)` | `hashtext('adcp.reporting:'‖id)` | Two SDKs on one database do not exclude each other. |
| Control totals in the content hash | `{name, value, value_type}` (protocol shape) | The Core path hashes `{name, value}` pairs, then serves typed totals | Python Core digests cannot be recomputed by buyers when totals are non-empty. |
| Identifier collation | Database default | `COLLATE "C"` | Ordering and uniqueness can differ. |
| Change feed | `recorded_at` timestamps under the account lock; persisted snapshot documents | Global `BIGSERIAL` change table, read per (account, consumer); stateless snapshots | Different cursors and recovery semantics. |
| Schema verification | None at runtime | Required-object catalog fingerprints at startup | Only Python detects DDL drift. |
| Retention | Revisions and rows are never deleted | A `readable` flag; rows are never deleted | Unbounded growth at pulse cadence. |
| PostgreSQL idempotency | `adcp_idempotency`, one `scoped_key` | `adcp_idempotency`, `(scope_key, key)` | The same table name already means two layouts. |

Snapshots: JS `68614aa0`; Python `a5d56a68` (idempotency) and `3c5fa308` (reporting).
References:
[JS reporting](https://github.com/adcontextprotocol/adcp-client/blob/68614aa0ce84046c78d76dda9721ffbf9328639a/src/lib/reporting/ledger/postgres.ts),
[Python reporting](https://github.com/adcontextprotocol/adcp-client-python/blob/a5d56a683661a79d76861ea6d1043a3aceda77f8/src/adcp/reporting/ledger/reporting_ledger.sql),
[JS idempotency](https://github.com/adcontextprotocol/adcp-client/blob/68614aa0ce84046c78d76dda9721ffbf9328639a/src/lib/server/idempotency/backends/pg.ts),
[JS claim coordination](https://github.com/adcontextprotocol/adcp-client/blob/68614aa0ce84046c78d76dda9721ffbf9328639a/src/lib/server/idempotency/store.ts),
[Python idempotency](https://github.com/adcontextprotocol/adcp-client-python/blob/a5d56a683661a79d76861ea6d1043a3aceda77f8/src/adcp/server/idempotency/backends.py).

**Volume is the second problem.** Social and retail adapters pull pacing snapshots every
15 minutes and an official report daily. As an illustration, take 2,000 feeds × 96
pulses × 1,000 rows of about 350 bytes each. That is about 192,000 revisions, 192 million
rows and 67 GB of canonical JSON per day, all in the transactional database. Adopters
that already land the same platform data in a warehouse then store it twice. Neither
SDK offers a supported way to put rows anywhere else.

## Design principles

- **Coordinate in PostgreSQL, store bytes anywhere.** Anything that needs a lock, a
  lease, a sequence or a compare-and-set lives in PostgreSQL. Only immutable,
  hash-bound row bytes may live outside it.
- **PostgreSQL is the trust anchor.** External stores are untrusted for integrity.
  Every read is verified against digests committed in PostgreSQL before rows are
  released.
- **Stored canonical bytes are authoritative.** Hashed content is stored as the exact
  canonical bytes the writer produced. Readers verify bytes and never re-serialize
  parsed values. Cross-language verification therefore never depends on number parsing
  or timestamp formatting.
- **Derived copies never feed back.** Warehouse sinks, analytics views and caches are
  downstream of the ledger. Nothing is served or verified from them.
- **No SDK's object graph is the schema.** Shared tables use explicit columns for
  identity, relationships, scheduling and protocol-defined evidence, and JSONB only for
  extensible payloads.
- **Credentials never reach the database, and the database cannot redirect writes.**
  Bindings hold non-secret coordinates. Clients and the set of permitted destinations
  come from host code.
- **Fail closed, visibly.** Expired, unavailable and corrupt rows produce distinct
  operator signals and are never reported as one another. The buyer-facing surface
  follows the protocol mapping in §3.5.

## 1. Ownership and release model

Create a language-neutral persistence package. It contains:

- canonical record contracts;
- PostgreSQL migrations and generated catalog manifests;
- Redis key/value contracts and scripts;
- the canonical row encoding;
- shared conformance fixtures.

Both SDKs consume pinned releases. Public APIs and database drivers stay native to each
language.

```text
persistence/
  manifest.json
  contracts/
    reporting-core/
    reporting-row-storage/
    reporting-warehouse-sink/
    idempotency/
  postgres/
    reporting-core/{migrations,catalog}/
    reporting-row-storage/{migrations,catalog}/
    idempotency/{migrations,catalog}/
  redis/
    idempotency/
  fixtures/            # golden canonical bytes, chunk/segment manifests, digests
  conformance/         # backend-neutral qualification cases
```

- **Location.** Start the source in a `persistence/` directory in this repository. Move
  it to a separate repository only if ownership or release operations warrant it.
- **Artifacts.** Publish immutable archives with checksums. npm and PyPI distributions
  bundle the same bytes. SDKs pin exact artifact releases. Startup and migration never
  fetch a mutable "latest" definition over the network.
- **Versions.** Protocol, persistence contract, component migration revision and SDK
  are versioned separately. The manifest records each component's dependencies,
  read/write contract versions, installed features and asset checksums. A reporting
  upgrade does not require an unrelated idempotency migration.
- **Migrations.** One history table, `adcp_persistence_migrations`, records component,
  revision, checksum and applied time. Migrations run under one deployment-wide
  advisory lock. Applied revisions are immutable. A non-transactional step needs a
  separately specified, resumable procedure.
- **Catalog verification.** Each component revision ships a generated catalog manifest:
  fingerprints of the required tables, columns, collations, defaults, constraints,
  indexes and triggers. Both SDKs verify required-object fingerprints at startup and
  ignore extra objects. That catches adopter DDL drift, which a migration history table
  cannot. This generalizes Python's `required_schema.json` model.
- **Administration.** Production migration is an explicit administrative action.
  Runtime SDKs inspect the manifest and catalog and refuse incompatible access; they
  never invent DDL. Existing helpers (`REPORTING_LEDGER_MIGRATION`, `create_schema()`)
  become thin wrappers around the shared runner. JS ships the first CLI. Python ships
  its own runner over the same assets, so a Python deployment never needs Node.
- **Governance.** Each component requires review from both SDK maintainers. This is
  reference persistence, not a mandatory technology for AdCP implementations. Custom
  stores may implement the semantic contracts on other substrates.

### 1.1 Contract format

Contracts are written in the same toolchain the protocol already uses: JSON Schema plus
normative prose. Both SDKs already generate types from JSON Schema, so no new IDL is
introduced. Each component directory contains:

```text
contracts/<component>/
  contract.json        # machine-readable contract, validated by contracts/contract.schema.json
  CONTRACT.md          # normative prose (MUST/SHOULD), operation semantics
  schemas/*.schema.json
```

- **`contract.json`** declares:
  - the component, its contract version and its dependencies on other components;
  - constants, such as segment and chunk limits and digest profiles;
  - the tables the component owns;
  - the lock-key registry: key template, lock mode and acquisition order;
  - state machines, with every state and allowed transition (for example `rows_state`
    and intent `state`);
  - operator error codes;
  - retention parameters, with their defaults and minimums.

  SDK tests assert that their constants, transitions and error codes match it.
- **`schemas/`** contains a JSON Schema (draft 2020-12) for every JSONB payload and every
  value that crosses a store port. Examples include chunk and segment manifests,
  per-provider binding `identity_config` and `operational_config`, locators, intent
  `created_objects`, `evidence`, and host cursors.
  - Schemas are closed (`additionalProperties: false`) unless a field is explicitly
    extensible.
  - `$id`s live under
    `https://adcontextprotocol.org/schemas/persistence/<component>/<version>/`.
  - SDK types are generated from these schemas (the existing TS pipeline; pydantic
    models in Python). They are never hand-edited, and CI fails on drift.
- **`CONTRACT.md`** specifies each operation's preconditions, postconditions,
  idempotency and failure semantics, and refers to schemas by `$id`.
- **Fixtures** (`fixtures/<component>/`) are golden vectors. Each is validated against
  the component's schemas.
- **Conformance** (`conformance/<component>/*.yaml`) holds declarative cases: setup
  state, an operation, and the expected resulting state, outcome or error. Each SDK runs
  them through a thin harness. Concurrency and crash cases that cannot be expressed
  declaratively are named in the contract and implemented per SDK against the same
  database.

## 2. Canonical reporting layout

### 2.1 Conventions

- **Names.** Table prefix `adcp_reporting_`, in a deployment-selected PostgreSQL schema.
  Legacy names are migration inputs only, never aliases that let old writers continue.
- **Identifiers.** Every identifier column is `TEXT COLLATE "C"`.
  `reporting_revision_id` is constrained to `^[A-Za-z0-9_.:-]{1,255}$`. Digests the SDK
  produces are lowercase hex. Comparisons against buyer-echoed digests are
  case-insensitive, matching the protocol pattern `^[A-Fa-f0-9]{64}$`.
- **Clocks.** Every authority instant (`recorded_at`, lease expiry, retention cutoffs)
  comes from `clock_timestamp()` in the committing database. It is rendered with
  exactly six fractional digits.
- **Installation identity.** The row-storage migration creates a singleton
  `adcp_persistence_installation(installation_id UUID)`. A restore of the same
  authority keeps it. An independently writable clone must mint a new one before it
  writes (§3.4).
- **Lock keys.** One account lock:
  `pg_advisory_xact_lock(hashtextextended('adcp.reporting.account:' || installation_id || ':' || account_id, 0))`.
  - Every writer takes it at transaction level, after any policy-row lock and before
    any other lock.
  - Transaction-level locks survive transaction-pooling proxies; session locks do not.
  - The contract lists every lock key and its order. Lock keys are part of the
    persistence contract version.
  - **Rolling upgrades.** A transitional contract version takes the SDK's legacy key,
    then the shared key, in that order. It does so until the manifest records that no
    legacy-key writer remains, so old and new workers of one SDK keep excluding each
    other.
- **Change feed.** A sequence-based change table is written in the same transaction as
  each record. Each row records `seq` and `xid xid8 DEFAULT pg_current_xact_id()`.
  `nextval` is taken only after the account lock, so per-account sequence order equals
  commit order and `changes_after` cursors never skip a lower number that commits
  later. Deployment-wide readers use `xid` (§3.7).
- **Payload JSONB.** Extensible evidence goes in an `evidence JSONB` column with a
  declared schema per contract version. When a payload field is also projected into a
  column, the contract states which side is authoritative.
- **PostgreSQL floor.** PostgreSQL 13 or later.

### 2.2 Core decisions

Each row proposes how to resolve a divergence. Exact DDL is a Stage 0 deliverable; this
table fixes the semantics it must encode.

| Topic | JS today | Python today | Proposal |
| --- | --- | --- | --- |
| Write safety | Obligation lease with generation fencing | Account lock, content-derived IDs, replay compare | **Database invariants are the safety contract.** Under the account lock, the rules in the next row serialize writers, and an unfenced stale writer loses cleanly with a numbering or supersession conflict. Obligation-lease fencing remains an optional scheduling optimization. |
| Revision ordering | Gapless `revision_number`; `NOT EXISTS official` predicate | Supersession chain; `_one_official`, `_one_successor` | **Both, database-enforced:** `UNIQUE(obligation, revision_number)` with number 1 as the root, which closes Python's two-root gap; `supersedes` is the number − 1 revision; one official per obligation; one successor per revision. |
| Configuration identity | Surrogate `configuration_id`; unique `(account, cfg, version)` | Natural key `(account, consumer, cfg, version)` | Natural key including `consumer_id`. JS writes its resolved account boundary as the consumer, preserving today's isolation. |
| Current revision | Derived by scanning revisions | Derived from the supersession leaf | The current revision is the obligation's highest `revision_number`. An official revision is terminal, so it is always the highest. With gapless numbering, the `UNIQUE (obligation, revision_number)` index makes the host current-revision read (§3.7) one index lookup, and no pointer column is needed. |
| Revision `kind` column | Always equals `finality` | Absent | Drop it. |
| Account on child rows | Revisions and adjustments lack `account_id` | Present, with account-qualified composite FKs | Present everywhere, with account-qualified composite FKs, including the chunk tables. |
| Content binding | `content_sha256` (= binding) plus JSON | `revision_content_sha256`, `row_count`, `control_totals` (pairs) | Explicit columns: `binding_algorithm`, `revision_content_sha256`, `canonical_byte_count`, `row_count`, `control_totals` in protocol shape (§2.4), and `row_manifest_sha256`. The name `content_sha256` is not reused. |
| Replay identity | Fingerprint of the stored object minus rows | Separate fingerprint over a field list | Replay compares **specified immutable columns**. Row location and `rows_state` are never part of replay identity. |
| Adjustments | Full corrected rows plus a rows-only hash | Control-total deltas only | Protocol shape: deltas, no rows. JS's retained adjustment rows move to the row store under digest profile `rows_v1` in Stage 1 (no data loss). Whether to keep them is decided in Stage 3. |
| Change feed | `recorded_at` plus persisted snapshot documents | Global sequence change table | Sequence-based change table (§2.1). Snapshot documents become an optional cache. |
| Readability | None | Bidirectional `readable`; `readable_at_commit` in identity | `rows_state` (§3.2). Python's `readable=false` maps to `unavailable`, and `readable_at_commit` is preserved in `evidence`. An operator restore may move `unavailable` back to `live` after re-verification. |
| Currency | Inside `data` | Column with CHECK and immutability trigger | Column with CHECK and immutability trigger. |
| Immutability | Application-enforced | Triggers on several evidence columns | Triggers on every immutable column. Only the row-location columns (§3.2) are mutable, guarded by `row_location_version`. |

### 2.3 Revision header (sketch)

```sql
CREATE TABLE adcp_reporting_revisions (
  reporting_revision_id        TEXT COLLATE "C" PRIMARY KEY
                               CHECK (reporting_revision_id ~ '^[A-Za-z0-9_.:-]{1,255}$'),
  account_id                   TEXT COLLATE "C" NOT NULL,
  reporting_obligation_id      TEXT COLLATE "C" NOT NULL,
  revision_number              INTEGER NOT NULL CHECK (revision_number > 0),
  finality                     TEXT NOT NULL CHECK (finality IN ('snapshot', 'official')),
  supersedes_reporting_revision_id TEXT COLLATE "C",
  -- protocol content binding (immutable)
  binding_algorithm            TEXT NOT NULL
                               CHECK (binding_algorithm IN ('rfc8785_jcs_v1', 'legacy_py_core_pairs_v0')),
  revision_content_sha256      TEXT COLLATE "C" NOT NULL CHECK (revision_content_sha256 ~ '^[0-9a-f]{64}$'),
  canonical_byte_count         BIGINT NOT NULL CHECK (canonical_byte_count > 0),
  row_count                    BIGINT NOT NULL CHECK (row_count >= 0),
  control_totals               JSONB NOT NULL,            -- protocol shape, §2.4
  row_manifest_sha256          TEXT COLLATE "C" NOT NULL, -- §3.1; immutable
  rows_shared_from_reporting_revision_id TEXT COLLATE "C", -- header-only revision (§4.2); immutable
  -- protocol metadata (immutable)
  observed_at TIMESTAMPTZ NOT NULL, data_through TIMESTAMPTZ, finalized_at TIMESTAMPTZ,
  finality_basis TEXT, finality_policy_id TEXT,
  source_publication_id TEXT COLLATE "C", source_manifest_sha256 TEXT COLLATE "C",
  canonical_content_digest JSONB,
  evidence                     JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  -- row location (the only mutable group; never part of replay identity)
  row_binding_id               TEXT COLLATE "C" NOT NULL,
  row_location_version         INTEGER NOT NULL DEFAULT 1,
  rows_state                   TEXT NOT NULL DEFAULT 'live'
                               CHECK (rows_state IN ('live', 'pruning', 'pruned', 'unavailable')),
  rows_state_changed_at        TIMESTAMPTZ,
  UNIQUE (reporting_obligation_id, revision_number),
  UNIQUE (account_id, reporting_revision_id)
  -- plus account-qualified composite FKs to the obligation and to the predecessor
);
CREATE UNIQUE INDEX adcp_reporting_revisions_one_official
  ON adcp_reporting_revisions (reporting_obligation_id) WHERE finality = 'official';
CREATE UNIQUE INDEX adcp_reporting_revisions_one_successor
  ON adcp_reporting_revisions (supersedes_reporting_revision_id)
  WHERE supersedes_reporting_revision_id IS NOT NULL;
```

### 2.4 Hashing and number contract

- **Revision binding.** `revision_content_sha256` is SHA-256 over the RFC 8785 JCS
  bytes of `{reporting_revision_id, row_count, control_totals, reporting_rows}`, as the
  protocol defines. Rows are concatenated in served order. In storage that is ordinal
  order, which is immutable. `control_totals` uses `reporting-control-total.json`:
  `{name, value, value_type[, unit]}` with canonical string values.
- **Python Core totals.** Python's Core path hashes `{name, value}` pairs, then serves
  typed totals. A buyer recomputing the digest from the wire fails whenever totals are
  non-empty, so this is a conformance bug. Python writes protocol-shape totals before
  any shared-layout claim.
  - Existing pair-hashed revisions are imported with
    `binding_algorithm = 'legacy_py_core_pairs_v0'`. That value is import-only, never
    written.
  - Exact reads of those revisions carry an operator diagnostic.
  - Legacy revisions with empty totals are byte-identical and import as
    `rfc8785_jcs_v1`.
- **Write-side number domain.** Writers emit RFC 8785 bytes. JS uses its existing
  `canonicalize`; Python uses `rfc8785.dumps`, already a core dependency. Writers refuse:
  - non-finite numbers;
  - integers beyond ±(2^53 − 1), which must be strings in the row schema;
  - lone surrogates;
  - duplicate object keys, detected while parsing source input.

  `-0` serializes as `0` per RFC 8785; that is not a refusal. The domain is fixed per
  contract version, not per SDK.
- **Read side.** Readers verify stored bytes and MUST accept any RFC 8785 number. A
  reader never re-canonicalizes stored rows for verification. Python's current
  float-rejecting re-verification in the materializer changes accordingly.
- **Digest profiles.** Each stored row set declares its profile:
  - `revision_envelope_v1`: the protocol revision binding.
  - `rows_v1`: SHA-256 of `JCS(rows)`, used only for JS-retained adjustment rows.
- **Other protocol digests.**
  - `canonical_content_digest` is the primary-key-sorted digest under a pinned
    canonicalization contract. It is mandatory for billing obligations and for
    materializations that select `canonical_digest`.
  - `canonical_adjustment_sha256` is required for `consumer_receipt` obligations.

  Both are stored as evidence and are never recomputed from typed columns.

## 3. Row storage

### 3.1 Canonical row encoding

Rows are stored as **canonical JSONL**: for each row in ordinal order, `JCS(row)`
followed by a single `\n`. JCS escapes newlines inside strings, so `0x0A` only ever
separates rows.

- **Segments and chunks (fixed in the contract).**
  - A *segment* is up to 500 consecutive rows. Segments are the unit of verification
    and of paged reads, so a 500-row delivery page touches at most two segments.
  - A *chunk* is up to 20 segments (10,000 rows) and at most 8 MiB of canonical bytes.
    Chunks are the unit of storage: one object, or one PostgreSQL body.
  - Boundaries are deterministic given the row sequence. A new chunk starts when the
    current chunk holds 10,000 rows, or when appending the next row would exceed
    8 MiB. Segments restart at each chunk boundary and close every 500 rows.
  - A single row larger than 8 MiB forms its own segment and chunk.
- **Manifest.** Each chunk records `{chunk_index, first_ordinal, row_count, byte_count,
  sha256, segments: [{first_ordinal, row_count, byte_offset, byte_count, sha256}]}`.
  The digests cover uncompressed canonical JSONL bytes. The header's immutable
  `row_manifest_sha256` is SHA-256 over the JCS of the ordered chunk manifests,
  locators excluded. So a database editor cannot drop, reorder or truncate chunks
  without failing every read.
- **Verification.** A reader checks that the manifest digest matches the header. It
  checks that ordinals are contiguous from 0 and sum to `row_count`. It checks that
  each segment it releases matches its digest and line count. A full read also
  verifies `revision_content_sha256`.
- **Envelope reconstruction.** JCS orders the envelope keys as `control_totals`,
  `reporting_revision_id`, `reporting_rows`, `row_count`. The preimage is therefore:
  - `{"control_totals":` + JCS(totals)
  - `,"reporting_revision_id":` + JCS(id)
  - `,"reporting_rows":[` + rows + `],"row_count":` + n + `}`

  Here "rows" is the JSONL lines without newlines, joined by `,`. There is no other
  whitespace. A zero-row revision contains `"reporting_rows":[]`. A verifier streams
  bytes and never parses a row. This equivalence has been checked against the JS
  canonicalizer for Unicode, nested values, numeric edge cases and many chunkings.
  Golden fixtures pin it for both SDKs.
- **Compression.** Optional per binding (`gzip`, one member). The locator records
  `physical_sha256` and `physical_byte_count`. A reader:
  1. aborts the read at `physical_byte_count`;
  2. verifies `physical_sha256` before inflating;
  3. rejects trailing data and extra gzip members;
  4. inflates to at most the manifest's `byte_count`.

  Objects are never stored with `Content-Encoding: gzip` on any provider; they use
  `application/gzip`. Compressed chunks are read whole, which is why chunks are capped
  at 8 MiB and SDKs may keep a verified-segment cache.
- **Empty revisions.** A zero-row revision has an empty manifest and no stored bytes. It
  is still distinct from a missing revision.

### 3.2 Storage bindings, chunks and write intents

A **storage binding** is an immutable, non-secret description of where row bytes go.
Revisions record the binding they were written with and their concrete chunk
locations, so old revisions resolve after configuration changes.

```sql
CREATE TABLE adcp_reporting_row_bindings (
  row_binding_id   TEXT COLLATE "C" PRIMARY KEY,
  kind             TEXT NOT NULL CHECK (kind IN ('postgres', 'object')),
  provider         TEXT NOT NULL,             -- postgres | gcs | s3 | azure_blob | filesystem | <host>
  identity_config  JSONB NOT NULL,            -- where bytes live: bucket/container, endpoint host, prefix, key template
  identity_sha256  TEXT COLLATE "C" NOT NULL, -- sha256(JCS(kind, provider, identity_config))
  operational_config JSONB NOT NULL,          -- compression, CMEK key name, labels; may change without a new binding
  namespace_key    TEXT COLLATE "C" NOT NULL, -- sha256(JCS(["adcp.rows.v1", deployment namespace, installation_id]))
  state            TEXT NOT NULL CHECK (state IN ('active', 'read_only', 'retired')),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  retired_at       TIMESTAMPTZ
);

CREATE TABLE adcp_reporting_revision_chunks (
  account_id       TEXT COLLATE "C" NOT NULL,
  reporting_obligation_id TEXT COLLATE "C" NOT NULL,
  reporting_revision_id TEXT COLLATE "C" NOT NULL,
  chunk_index      INTEGER NOT NULL CHECK (chunk_index >= 0),
  first_ordinal    BIGINT NOT NULL,
  row_count        INTEGER NOT NULL CHECK (row_count > 0),
  byte_count       BIGINT NOT NULL CHECK (byte_count > 0),
  sha256           TEXT COLLATE "C" NOT NULL,
  segments         JSONB NOT NULL,
  -- location (mutable only through a guarded move, §3.6)
  object_key       TEXT COLLATE "C",          -- NULL for postgres; indexed for sweeps
  native_version   TEXT,                      -- GCS generation, S3/Azure version id or ETag
  physical_sha256  TEXT COLLATE "C",
  physical_byte_count BIGINT,
  PRIMARY KEY (reporting_revision_id, chunk_index),
  FOREIGN KEY (account_id, reporting_revision_id)
    REFERENCES adcp_reporting_revisions (account_id, reporting_revision_id)
  -- index (object_key) and (account_id, reporting_obligation_id, sha256) for sharing checks
);

-- postgres kind only. Content-addressed within one obligation, so header-only
-- revisions (§4.2) share bodies with the revision they repeat.
CREATE TABLE adcp_reporting_chunk_bodies (
  account_id       TEXT COLLATE "C" NOT NULL,
  reporting_obligation_id TEXT COLLATE "C" NOT NULL,
  sha256           TEXT COLLATE "C" NOT NULL CHECK (sha256 = encode(sha256(body), 'hex')),
  body             BYTEA NOT NULL,
  PRIMARY KEY (account_id, reporting_obligation_id, sha256)
);

CREATE TABLE adcp_reporting_row_write_intents (
  row_binding_id   TEXT COLLATE "C" NOT NULL REFERENCES adcp_reporting_row_bindings,
  account_id       TEXT COLLATE "C" NOT NULL,
  reporting_revision_id TEXT COLLATE "C" NOT NULL,
  revision_content_sha256 TEXT COLLATE "C" NOT NULL,
  state            TEXT NOT NULL CHECK (state IN ('open', 'sweeping')),
  owner_token      TEXT COLLATE "C" NOT NULL,
  created_objects  JSONB NOT NULL DEFAULT '[]', -- [{object_key, native_version}] this installation created
  expires_at       TIMESTAMPTZ NOT NULL,        -- derived from the database lease expiry, not a host clock
  PRIMARY KEY (row_binding_id, reporting_revision_id, revision_content_sha256)
);
```

- **Inline storage is still split.** The `postgres` kind stores canonical JSONL chunk
  bodies as `BYTEA`, and the database checks each body's digest. That gives byte-exact
  cross-SDK verification and about a thousand times fewer tuples than one JSONB value
  per row. Rows never return to the header.
- **Shared chunks.** A header-only revision (§4.2) copies the chunk manifests and
  locations of the revision it repeats, and names it in the immutable header column
  `rows_shared_from_reporting_revision_id`.
  - Sharing is limited to one obligation, which means one account and one
    configuration generation, never across consumers.
  - Bytes are removed only when no non-pruned chunk row in the same binding still
    references them. Pruning and moves check that under the account lock, using the
    `object_key` and body-digest indexes.
- **`rows_state`.**
  - `live`: rows are readable.
  - `pruning` / `pruned`: rows were deliberately removed by retention (§4).
  - `unavailable`: a verified read found bytes missing, a key revoked, or an adopter
    restore pending. A reader that hits a missing or mismatched chunk first re-reads
    the header. If the location moved or retention ran, the reader retries or reports
    expiry. Only a confirmed loss marks `unavailable` and raises an operator alert.
- **Hold-creating writes.** Receipts, consumer statuses, adjustments and
  materializations take the account lock and require `rows_state = 'live'` in the same
  transaction. Pruning cannot race them.
- **Binding allowlist.** A binding is usable only if its
  `(provider, identity_config)` appears in a host-code allowlist. The SDK refuses writes
  and deletes on any binding whose `namespace_key` differs from the locally computed
  one, including imported bindings. Someone with database write access therefore cannot
  redirect rows to a bucket they control.
- **Credentials.** The host maps a binding's `credential_ref` to an official client
  through a closed map: ADC, workload identity or impersonation on GCP; IAM roles or
  IRSA on AWS; managed identity on Azure. There is never an environment or file lookup.
  Per-provider config schemas are closed (`additionalProperties: false`, endpoint host
  only), so a secret embedded in a URL cannot enter the database.

### 3.3 Row store port

Each SDK exposes the same semantic port, in its own idiom.

```ts
interface ReportingRowStoreV1 {
  readonly kind: 'postgres' | 'object';
  readonly capabilities: { nativeCreateOnly: boolean; rangedReads: boolean };
  /** Validates the binding, its policy and (for S3-compatible stores) empirical create-only behaviour. */
  probe(binding: RowBindingV1, ctx: RowStoreContextV1): Promise<void>;
  /** Writes every chunk create-only. Returns locators plus the subset this call created. A different
   *  body already at a derived key is CONTENT_CONFLICT; identical bytes are adopted, never recorded as created. */
  putChunks(input: RowWriteInputV1, ctx: RowStoreContextV1): Promise<RowPutResultV1>;
  /** Returns verified canonical bytes for one segment range of one chunk. */
  readSegments(header: RowSetHeaderV1, chunk: RowChunkManifestV1, segments: [number, number], ctx: RowStoreContextV1):
    Promise<Uint8Array>;
  /** Deletes exactly the recorded native versions. 'absent' is success. */
  deleteObjects(binding: RowBindingV1, objects: RowObjectRefV1[], ctx: RowStoreContextV1):
    Promise<'deleted' | 'absent'>;
}
```

- **Guarantees.**
  - Bytes at a locator never change, either natively or because every read verifies
    them.
  - Retries converge, and a concurrent writer with different content cannot replace
    the first.
  - Once `putChunks` returns, every chunk is readable.
  - Deletes target exact recorded versions, so they cannot remove a later object at
    the same key.
- **Deadlines.** Every operation has a deadline and honours cancellation. A timeout
  never means "nothing was written".
- **Operator error codes.** Stable and secret-free: `INVALID_INPUT`, `CONTENT_CONFLICT`,
  `ROWS_INTEGRITY_FAILED`, `ROWS_UNAVAILABLE`, `ROWS_EXPIRED`, `PROVIDER_UNAVAILABLE`,
  `DEADLINE_EXCEEDED`, `ABORTED`, `UNSAFE_BINDING`, `STATE_UNAVAILABLE`. Raw provider
  errors are never surfaced.

### 3.4 Backends

**`postgres` (default).** Chunk bodies are written in the same transaction as the header.
This is the only backend where header and rows commit atomically. It suits tests, small
deployments and small revisions. Batches stay small enough to fit the account-lock
timeout.

**`object`: GCS, S3, Azure Blob, filesystem.** One object per chunk, written create-only.
On a precondition failure, the writer reads the existing object and adopts it only if its
bytes are identical.

| Provider | Create-only write | Conflict | Native version recorded |
| --- | --- | --- | --- |
| GCS | `ifGenerationMatch: 0` | 412 | generation |
| S3 | `If-None-Match: *` on PutObject / CompleteMultipartUpload | 412 (retry on 409) | version id when versioned, else ETag |
| Azure Blob | `If-None-Match: *` | 409 `BlobAlreadyExists` or 412 | version id or ETag |
| Filesystem | write temp, `fsync`, `link()` to final name (no-replace) | `EEXIST` | inode + mtime (tests only) |

- **Keys.** Rendered keys MUST begin `{prefix}/{namespace_key}/`. Templates may add:
  - `{account_key}`
  - `{period_date}` with a declared format and timezone
  - `{finality}`
  - `{revision_key}`
  - `{content_sha256}` (required)
  - `{chunk_index}` (required)

  The SDK rejects any rendered key outside the binding's owned prefix. The rendered
  key is stored, never re-derived.
- **Account key.**
  `account_key = sha256(JCS(["adcp.account_key.v1", namespace_key, account_id]))`.
  A host HMAC key can replace it where account identity is sensitive. Raw account IDs
  are never placed in keys. Hashed keys are pseudonymous: object sizes and timing still
  reveal per-account volume.
- **Default template.**
  `{prefix}/{namespace_key}/{account_key}/{period_date:yyyy/MM/dd}/{finality}/{revision_key}/{content_sha256}/{chunk_index}.jsonl[.gz]`.
  The date and finality segments let adopters attach lifecycle rules and load scopes by
  prefix.
- **Bucket policy.** Row bindings use a probe profile separate from Managed Delivery.
  - Required: private access, and uniform bucket-level access on GCS.
  - Allowed as backstops: versioning, soft delete and retention locks. `pruned` is not
    "erased" while versioning or soft delete keeps old bytes.
  - Refused with `UNSAFE_BINDING`: any lifecycle rule or expiration that can delete
    live rows sooner than the ledger's retention. The check is repeated periodically,
    not once.
  - Row buckets and Managed Delivery buckets are separate bindings.
- **Clones and restores.** A restored replica of the same authority keeps
  `installation_id`. An independently writable clone (staging from a production
  snapshot) must mint a new `installation_id` and new bindings before writing or
  sweeping.
- **Implementations.** The SDK ships GCS, S3 and Azure Blob providers against the
  official clients, as optional peer dependencies (Python extras
  `adcp[reporting-gcs|reporting-s3|reporting-azure]`). It also ships the filesystem
  provider for tests. Hosts can register other providers, for example R2 or MinIO,
  behind the same probe.

### 3.5 Write, read and the wire mapping

**Write** (external backends):

1. **Check for replay.** If a header for this revision ID and content already exists,
   return it without uploading.
2. **Canonicalize and chunk.** Compute segments, chunks, the manifest digest and the
   envelope digest, and run the existing binding validation.
3. **Check the lease budget.** Read the remaining lease from the database. Refuse to
   upload unless it covers the write deadline plus a margin; renew it if the store
   supports renewal.
4. **Transaction A: open or take over the intent.** Upsert the intent for
   `(binding, revision, content)`. A writer takes over an expired `open` intent but
   never one in `sweeping`.
5. **Upload.** Run `putChunks` outside any transaction and without the account lock.
   Append the objects this call created to `created_objects`.
6. **Transaction B: commit.** Run the existing `commitRevision` under the account lock:
   insert the header and chunk manifest, then delete the intent with
   `WHERE state = 'open' AND owner_token = $owner`. If that delete matches nothing,
   the transaction fails and the header does not commit.

A crash, lost lease or numbering conflict leaves an intent that the sweep (§4.3)
resolves. A header never commits without its bytes. A sweep takes an intent to
`sweeping` under the account lock before deleting, so transaction B can no longer
commit against it. The `postgres` backend skips steps 3–5 and writes bodies in
transaction B.

**Read:**
1. Load the header and manifest with the account check, and require
   `rows_state = 'live'`.
2. Verify the manifest digest.
3. Read only the segments the page needs, and verify each one before releasing rows.

Delivery pages map to segments, and `total_count` comes from the header. The status
`revision` view is bounded by the same paging. Cursors carry `row_location_version`
and re-resolve if rows move.

**Metadata-only paths never read rows.** These include the producer, lifecycle
reconciliation, status ingest, snapshot building, materialization planning and
notification ports. Managed Delivery claims return the header; the runtime hydrates and
verifies rows within the adapter's byte limit before calling `deliver()`.

**Wire mapping.**
- **Inside the retention window**, `ROWS_UNAVAILABLE` and `ROWS_INTEGRITY_FAILED`
  never become a not-found and never release unverified rows.
  - An exact read returns `SERVICE_UNAVAILABLE`.
  - The obligation can no longer be `healthy` or `complete`.
- **Outside the window**, `ROWS_EXPIRED` returns the same non-disclosing not-found as an
  unknown ID. The revision leaves every protocol projection, and
  `scope.ledger_retained_from` advances past its period.
- **Buyer-facing responses** collapse the operator codes, so a buyer cannot use them to
  test whether an object exists.

### 3.6 Warehouse sinks and adopter flexibility

A **warehouse sink** is a derived, non-authoritative copy of committed revisions, fed
from the PostgreSQL change feed. It is never read for serving or verification. Because
it cannot break a hash, everything about it is adopter-defined:

- project, dataset and table names;
- column mapping and types (money as `NUMERIC`, never `FLOAT64`);
- partitioning and clustering;
- retention.

**BigQuery sink (first implementation).**
- Each tick, the sink reads the next range of committed revisions from the change feed
  (§3.7) and reads their rows through the verified row reader. It applies the
  adopter's column map plus standard revision columns, and loads them as newline-
  delimited JSON. It runs one load job per table: rows first, then revision metadata.
  - The batch (change-feed range and revision list) is recorded in PostgreSQL before
    any load. Job IDs derive from the sink and that range.
  - A crash between a load and the cursor commit replays the same batch under the same
    job IDs, which BigQuery refuses to run twice.
  - A job that finished with an error is retried under a new attempt suffix for that
    table only.
  - Only committed revisions are loaded; orphans and losing attempts never reach the
    warehouse.
  - Ingestion uses the free shared slot pool, and ninety-six ticks a day sit far
    below per-table load quotas.
  - The sink registers as a change-feed consumer, so the feed keeps changes it has
    not loaded yet.
- Loading mapped rows, rather than the stored objects directly, lets the warehouse
  carry adopter-chosen typed columns and revision metadata that a raw object load
  cannot. It also works for PostgreSQL-stored rows. Optional columns: `row_jcs STRING`
  for exact bytes, and `row JSON` for cheap field access.
- The sink also writes commit metadata: revision ID, obligation, finality, supersession,
  period, binding digest, row count and control totals.
- The sink ships a reference **`current_rows` view** that keeps only each obligation's
  leaf revision: the official revision, otherwise the latest snapshot. Cumulative
  snapshots double-count spend when summed across revisions, which is the most likely
  analyst error.
- `period_date` is defined explicitly: the reporting period's date in the source
  timezone, for example the ad account's timezone on Meta. Row-level dates are
  projection columns.
- Binding options:
  - `location`, so jobs run in the dataset's region (residency per tenant);
  - a separate billing project from the data project;
  - a CMEK `kms_key_name`;
  - table and job labels for cost attribution;
  - a reservation assignment;
  - separate impersonated service accounts for writer, reader and sweeper.
- All calls work through VPC Service Controls restricted endpoints. Identifiers are
  validated and quoted, and values are always query parameters.
- Shared analytics datasets are never granted to tenant principals. Per-tenant
  analytics use a per-tenant dataset sink or row-access policies.
- **Sink retention is the adopter's.** Ledger row retention governs serving copies
  only. Superseded snapshots are the intraday pacing curves analysts want, and a sink
  may keep them indefinitely.

**Recommended GCP deployment:** an `object` binding on GCS, plus a BigQuery load-job
sink into a native table. GCS gives create-only writes, reads in tens of milliseconds and
negligible storage cost. BigQuery gets typed, partitioned, analyst-ready rows. That is
the "metadata in PostgreSQL, raw partitioned data in the warehouse" split, without a
second authoritative copy. External or BigLake tables over the prefix suit low volume or
ad hoc use only: pulse volume produces hundreds of thousands of small objects a day.

**Other flexibility:**
- **Choosing a binding per revision.** The host supplies
  `selectRowBinding({account_id, adapter_id, feed_purpose, finality, canonical_byte_count})`.
  `adapter_id` comes from the reporting service, which knows the adapter. Example
  routes: inline under 256 KiB, a tenant-specific bucket for one agency, a shared
  bucket for everyone else. Several bindings can be active at once.
- **Per-tenant isolation.** A bucket, prefix or project per tenant is just another
  binding.
- **Moving rows between backends.**
  1. Copy and verify each chunk on the new binding.
  2. Compare-and-set the chunk locations and `row_location_version`.
  3. Delete the old versions after a grace period longer than the longest read
     deadline.

  A move whose destination key equals a source key is refused, so a move can never
  delete the only copy.
- **Source-manifest reuse.** The JS producer already pins its source objects by SHA-256
  and size. A future `reference` kind could serve rows from those pinned objects
  through the pinned adapter transform, as a documented, verified exception to "never
  re-serialize". It is out of scope until an adopter needs it (§9).

### 3.7 Host reads: current revisions and change cursors

In-process consumers such as pacing, alerts and the warehouse sink itself need
serving-grade reads from the ledger, not from the warehouse.

- **Current revision.** The current revision is the obligation's official revision if
  one exists, otherwise its highest-numbered snapshot.
  - `getCurrentRevision({account_id, reporting_obligation_id})` returns that header in
    one index lookup on the obligation's `current_reporting_revision_id`.
  - `listCurrentRevisions({account_id, delivery_config_id?, period_start_from,
    period_start_to, limit, cursor})` pages current revisions for a period range, using
    the obligations' `(account_id, period_start)` index.
  - Both return headers. Rows are read separately through the verified paged reader.
- **Change cursor.** `changesAfter({cursor, account_id?, kinds?, limit})` reads the
  sequence change table (§2.1). It returns `{records, cursor}`, where each record
  carries kind, record ID, obligation, account and `recorded_at`. Cursors are opaque,
  versioned and stable across restarts, processes and SDKs, because both SDKs read the
  same table.
  - **Account-scoped feeds** order by sequence number. They are gap-free because
    `nextval` is taken under the account lock, which is held until commit.
  - **Deployment-wide feeds** order by `(xid, seq)`, where `xid` is the writing
    transaction's `pg_current_xact_id()`. They return only rows whose `xid` is below the
    reading snapshot's `pg_snapshot_xmin`. Any row not yet visible therefore sorts after
    every row already returned, and a slow commit can never be skipped. A long-running
    transaction delays the deployment-wide feed; it never makes it lose a record.
  - A cursor older than the change-table retention horizon (§4.2) fails with
    `CURSOR_EXPIRED`. The consumer then resynchronizes from `listCurrentRevisions` and
    resumes from the cursor returned with that read.
- **Durable consumers.** A host may register a named consumer, with its position in
  its own feed order, in
  `adcp_reporting_feed_consumers(name, cursor, updated_at)`. A registered consumer
  holds back change-table pruning, up to a cap (`max_feed_hold_days`), so a dead
  consumer cannot block retention indefinitely. The warehouse sink is a registered
  consumer.
- These are host APIs, not buyer surfaces. Buyers keep the protocol's
  `changes_checkpoint` and `changes_after`, which project from the same table.

## 4. Retention

### 4.1 Protocol constraints

- **Metadata.** `status_retention_days` is the minimum period for which obligation,
  revision and materialization metadata remain queryable.
- **Superseded snapshots.** `reporting-revision.json` says provisional restatements
  "preserve the superseded snapshot for the advertised retention window". Exact reads
  by `reporting_revision_id` are not limited to current revisions.
  `get_reporting_status` says all historical revisions retained under the window
  appear in the ledger. Superseded snapshot content therefore stays readable for
  `status_retention_days`.
- **Healthy and complete obligations.** `core_readability` requires an authoritative
  revision readable through `get_media_buy_delivery` and reporting webhooks for
  `healthy` and `complete` obligations.
- **Managed Delivery.** `resource_retention_days` and `resource_retained_until` govern
  materializations.
- **Period alignment.** `scope.ledger_retained_from` is a period boundary across every
  selected configuration generation. Obligations, revisions, adjustments, consumer
  statuses and receipts for a period therefore expire together.

### 4.2 Policy

- **Retained as a unit.** Every revision's header, manifest and rows are retained for at
  least `status_retention_days`. The window is anchored at the later of publication and
  obligation completion, and expiry is period-aligned. Rows outlive that window while a
  receipt, consumer status, adjustment or live materialization still names the
  revision.
- **After expiry.** The period's records leave the protocol projection together, and
  `ledger_retained_from` advances. Every retained record has an explicit bound:

  | Record | Retained | Then |
  | --- | --- | --- |
  | Row bytes | The protocol window, plus holds | Pruned (§4.3) |
  | Headers, chunk manifests, consumer statuses, receipts, issues, transitions and lifecycle state for a period | `ledger_record_retention_days` after the period expires. Default `status_retention_days`; never less | Deleted together, in one period-aligned transaction under the account lock |
  | Per-obligation tombstone: obligation ID, configuration generation, period, final current revision ID, `revision_content_sha256`, `row_manifest_sha256`, revision count, `pruned_at` | Indefinitely, about 200 bytes per obligation | Refuses replays that would resurrect pruned IDs, and preserves the audit conclusion |
  | Change-table rows | `change_retention_days` (default 30; never less than the protocol checkpoint TTL), extended by registered consumers up to `max_feed_hold_days` | Deleted. Older cursors get `CURSOR_EXPIRED` |
  | Idempotency replay rows (consumer-status and receipt batches) | Their 30-day replay window | Deleted. Today's lifetime per-consumer caps become active-window caps |

- **Configuring a shorter window.** A deployment that needs less pulse history
  advertises a shorter `status_retention_days`. A row retention shorter than the
  advertised window is non-conformant, and the SDK refuses it.
- **Unchanged pulses become header-only revisions.** When a pulse's canonical rows are
  byte-identical to the current revision's, the producer mints a normal snapshot
  revision. It has a new ID, `revision_number`, `observed_at` and `data_through`, and a
  newly computed `revision_content_sha256`, which binds the new ID. It shares the
  previous revision's chunks instead of storing them again (§3.2).
  - **Detecting identical rows.** Rows are identical when `row_manifest_sha256` matches.
    The producer still holds the rows it just pulled, so it computes the new envelope
    digest normally and skips only the upload.
  - **Why not skip the pulse.** Skipping would freeze freshness. A buy that has stopped
    delivering returns identical rows every pulse, and pacing and delivery-health
    consumers must be able to tell "stopped delivering" from "nobody checked". The
    protocol has no way to advance `observed_at` or `data_through` without a revision.
  - **Scope.** Sharing never crosses obligations, so it never crosses consumers.
  - **Cost.** Header-only revisions cost a header, a few manifest rows and a change-feed
    record. Repeated identical revisions are themselves the retained evidence that
    `stabilized` finality requires.

### 4.3 Pruning and intent sweeps

- **Pruning.**
  1. In one transaction under the account lock, mark an expired period's revisions
     `pruning`, after re-checking holds.
  2. Delete the recorded object versions that no non-pruned chunk row still
     references. Deletion is idempotent and resumable.
  3. Mark the revisions `pruned`.

  External bytes are never deleted first. The `postgres` backend deletes unreferenced
  bodies in step 1's transaction.
- **Record deletion.** When `ledger_record_retention_days` elapses, one period-aligned
  transaction under the account lock does three things:
  1. writes the obligation tombstone;
  2. deletes the period's headers, manifests, statuses, receipts, issues, transitions
     and lifecycle rows;
  3. records the deletion in the change table so mirrors can follow.

  Batches stay small enough to fit the account-lock timeout.
- **Change-table pruning.** Deletes rows older than `change_retention_days` that every
  registered consumer has passed, or whose consumer has exceeded `max_feed_hold_days`.
- **Intent sweeps.** Under the account lock, move an expired `open` intent with no
  committed header to `sweeping`. Then delete only its `created_objects`, at their
  recorded versions, and drop the intent.
  - Adopted objects are never recorded as created, so they are never swept.
  - A locator named by any header or unexpired intent, in any binding, is skipped.
  - Created objects carry `adcp-installation` and `adcp-intent` metadata.
  - A listing-based backstop is off by default. When enabled, it deletes only objects
    whose metadata names this installation and an expired local intent.
- **Scheduling.** The production service schedules pruning, intent sweeps and the
  existing snapshot and checkpoint sweep. Today JS exports
  `sweepExpiredReportingLedgerState`, but nothing schedules it.

## 5. Concurrency contract across SDKs

The shared layout is qualified for **concurrent mixed-SDK writers**, not only sequential
handoff. That requires:

- identical lock keys, lock order and timeouts, including the transitional dual-key
  rule (§2.1);
- database-enforced revision invariants as the safety contract (§2.2);
- the change table written after the account lock, in the same transaction as each
  record;
- database-clock instants only;
- startup catalog verification;
- a recorded installed-feature set. An SDK that cannot read an installed component (for
  example, a provider it lacks) refuses the affected work rather than skipping it.

## 6. Idempotency

Idempotency stays in scope as a later stage. The semantic state machine is agreed before
the physical layout. It covers:

- deployment, tenant and principal scope;
- account binding where required;
- operation binding (a reused key on another tool conflicts);
- canonical request hashing and its exclusions;
- cached response representation;
- claim ownership with owner tokens and lease generations;
- completion, conflicts and ambiguous-outcome reconciliation;
- logical versus physical expiry.

PostgreSQL gets one shared DDL and operation contract. Redis gets versioned key
encoding, value schemas, clock rules and shared Lua scripts with defined cluster key
placement. The store alone cannot make arbitrary external side effects atomic.
These contracts implement the
[security and idempotency rules](../docs/building/by-layer/L1/security.mdx).
[DR-0021](../governance/decisions/DR-0021-idempotency-ledger-outlives-resource.md) is
related but still proposed; this document does not ratify it.

## 7. Adoption plan

The row-storage tables are new, so they are designed in the canonical shape from day one.
They ship before the full Core layout converges, which delivers storage relief first
without doing the work twice.

| Stage | Deliverable | Acceptance gate |
| --- | --- | --- |
| 0. Contracts | `persistence/` skeleton and manifest; canonical JSONL encoding, segment/chunk rules and golden fixtures; row-storage DDL and catalog manifest; Core field mapping and decisions; lock-key registry | Both SDK maintainers approve. JS and Python produce byte-identical chunks, manifests and digests for every fixture. |
| 1. JS row storage | See the PR sequence below | Each provider passes shared conformance against a real or emulated backend. Legacy inline rows migrate without changing any digest. |
| 2. Python row storage | Python adopts the same tables and encoding. Row location lives in a side table until Stage 3. `reporting_revision_rows` is migrated with verification, then dropped or renamed, not truncated, so pre-chunk binaries fail closed. Protocol-shape control totals; byte-verifying readers. | JS-written chunks verify in Python and vice versa, against one database and one bucket. Any migration mismatch quarantines the revision as `ROWS_INTEGRITY_FAILED`; it is never rewritten. |
| 3. Canonical Core layout | Shared Core DDL, immutable migrations, catalog manifests; runners in both languages; migrations from both legacy layouts; transitional dual-key locks; cutover runbook | JS and Python write, read and hand off against one database. Concurrent mixed writers pass contention tests. Legacy evidence keeps its original digests. |
| 4. Idempotency | Shared state machine, PostgreSQL operations, Redis format and scripts | Mixed-language replay, contention, stale-owner and crash-recovery cases pass for each backend. |
| 5. Operational extensions | Managed delivery, receipts, notifications and outboxes, replay protection, scheduling | Each qualifies separately behind installed-feature checks. |

**Stage 1 PR sequence (JS).** Each PR is small and carries a changeset. Implemented in
adcontextprotocol/adcp-client #3145, #3146, #3152, #3155, #3157, #3159, #3160, #3163,
#3165, #3167, #3161, #3164, #3166, #3168 and #3169. Two implementation decisions
differ from the sketches above:

- Until Stage 3, the JS SDK keeps row location in an `adcp_reporting_row_sets` side
  table keyed by revision or adjustment ID, the same pattern as Python's Stage 2. A
  revision without a row set carries its rows inline.
- The change table is a separate opt-in migration
  (`REPORTING_LEDGER_CHANGES_MIGRATION`, PostgreSQL 13+ for `xid8`), so the Core
  migration keeps its lower PostgreSQL floor. It records obligation, revision,
  adjustment and retirement changes.

Registered consumers store their position in their own feed order: `(xid, seq)` for
deployment-wide consumers, and account plus `seq` for account consumers. Pruning
deletes a change only once every live consumer has passed it in that order. The
retention tombstone table is part of the Core migration, so retention also works
without row storage.
1. Canonical JSONL encoder, segmenter, chunker and streaming verifiers, with golden
   fixtures. No database.
2. Metadata-only read paths (`listRevisionMetadata` and siblings), switching the
   producer, lifecycle, status ingest and planner. No schema change.
3. Paged, verified `readRevisionRows` for the delivery handler, and a bounded status
   `revision` view.
4. `REPORTING_ROW_STORAGE_MIGRATION`: installation identity, bindings, chunks, bodies,
   intents, and nullable location and `rows_state` columns on existing tables.
5. `postgres` kind behind a `rowStorage` store option, and dual-path reads (inline or
   chunked).
6. Managed Delivery hydration in the runtime; header-only claims.
7. Resumable in-place migration of inline rows. Batches are bounded for the lock
   timeout, and the guide notes that `VACUUM FULL` or a repack reclaims space.
8. `ReportingRowStoreV1`, the external write path (replay check, lease budget, fenced
   intents), the filesystem provider and the conformance suite.
9. Retention: row pruning, record deletion with tombstones, change-table pruning and
   intent sweeps, scheduled by the production service.
10. Host reads: the current-revision pointer, `getCurrentRevision`,
    `listCurrentRevisions`, `changesAfter` and registered feed consumers.
11. Header-only revisions for unchanged pulses, with reference-checked chunk sharing.
12. GCS provider.
13. S3 provider.
14. Azure Blob provider.
15. BigQuery load-job warehouse sink with the `current_rows` view.
16. Guides and migration notes.

The existing `ReportingLedgerStore` stays source-compatible. New capabilities are
optional methods that callers feature-detect. `commitRevision` still receives full
rows, and the store decides where they go. `getRevision` remains as a verified,
size-capped hydrating read.

**Legacy cutover.**
1. Stop writers, and drain or explicitly preserve outstanding work.
2. Export a consistent account snapshot and preflight it.
3. Migrate it atomically into an empty destination.
4. Verify readback before resuming.

Keep the source for recovery. Once destination writes begin, reverting requires
reconciling them.

## 8. Qualification

- **Same backend, both SDKs.** Both adapters run against the same PostgreSQL schema and
  the same bucket in CI. Separate databases only prove wire interoperability.
- **Core cases:**
  - write and read in both directions; sequential handoff; concurrent writers;
  - rolling upgrade under dual lock keys;
  - account isolation;
  - identical-ID replay; conflicting-content refusal;
  - zero rows versus a missing report;
  - typed totals; Unicode and JCS number edge cases;
  - supersession and root uniqueness; readback of original digests;
  - catalog-drift detection.
- **Row-storage cases**, per provider:
  - create-only conflict with identical and different bytes;
  - a crash after upload but before commit;
  - intent takeover versus sweep;
  - a sweep never deleting adopted objects;
  - chunk tampering, truncation and reordering, in the bucket and in PostgreSQL;
  - a deleted object (`ROWS_UNAVAILABLE`);
  - pruning racing a reader (expiry, never integrity failure);
  - pruning racing a hold-creating write;
  - header-only revisions sharing chunks, where pruning one revision keeps bytes still
    referenced by another;
  - moves with colliding keys;
  - decompression limits;
  - key-template and allowlist refusal;
  - an empirical create-only probe on S3-compatible stores;
  - the wire mapping for every row-state.
- **Sink cases:**
  - idempotent load-job retry;
  - orphan exclusion;
  - `current_rows` leaf selection across restatements.
- **Host-read cases:**
  - the current-revision pointer after restatement and after an official revision;
  - account-scoped and deployment-wide `changesAfter` under interleaved commits,
    including a long-running transaction holding a lower `seq`;
  - `CURSOR_EXPIRED` and resynchronization;
  - a registered consumer holding back pruning, up to its cap.
- **Retention cases:**
  - period-aligned record deletion;
  - a tombstone refusing a resurrected replay;
  - replay-row expiry.
- **Compatibility matrix.** Published per component and artifact version, distinguishing
  export/import, sequential handoff and concurrent participation.

## 9. Alternatives considered

- **BigQuery as the ledger database.** Rejected. The ledger needs row locks, `SKIP
  LOCKED` leases, gapless numbering under concurrency, and a change feed committed with
  each record. BigQuery offers none of these and limits concurrent DML per table.
- **BigQuery as the authoritative row store.** Deferred.
  - It works only with exact canonical strings, mandatory re-verification (BigQuery has
    no row immutability) and attempt filtering.
  - Point reads take about a second, and the query minimum is 10 MB billed.
  - Per-revision write streams hit project stream quotas at pulse volume.
  - The warehouse sink gives analysts typed BigQuery tables without those costs. A
    `bigquery` row-store kind can be added later behind the same port if an adopter
    needs a single copy.
- **Pointing at rows the adopter already stores in a warehouse.** Deferred.
  - Typical platform landing tables are merged or have partitions overwritten, which
    breaks earlier revisions.
  - Selectors re-run per read, which drives warehouse cost.
  - A selector that misses its account filter mints another tenant's evidence.
  - Re-deriving bytes from typed columns contradicts the canonical-bytes principle.
  - The sink covers the analytics need without this.
- **Rows inline in PostgreSQL, with retention only.** Simpler, but it keeps bulk bytes in
  the transactional database and makes verification depend on JSONB re-serialization.
- **One JSONB per row (Python today).** Rejected for storage. It does not preserve
  canonical bytes, and per-row tuples create very large indexes and vacuum load.
- **Each SDK designs its own row store.** Rejected. Readers must verify each other's
  bytes, so encoding, chunking and locators must be shared.
- **Making one SDK the schema manager.** It ties the other language to that SDK's release
  cadence and runtime.

## 10. Decisions for review

Recommended:
- shared package ownership, with source in this repository;
- independently versioned components and generated catalog manifests;
- explicit production migrations;
- the Core decisions in §2.2;
- row storage (§3) and the BigQuery warehouse sink, shipped first in Stages 1 and 2.

Open questions and upstream follow-ups:

1. **Superseded-snapshot readability (protocol).** Confirm that the
   `reporting-revision.json` description is normative for content readability. Name the
   instant that anchors `status_retention_days`. Promote both to normative text.
2. **Unreadable retained revision (protocol).** No issue code currently means "a
   retained revision is unreadable". This proposes adding one rather than overloading
   `PRODUCTION_FAILED`.
3. **Not-found error code (protocol).** `get_media_buy_delivery` names
   `REPORTING_REVISION_NOT_FOUND`, which is not in `enums/error-code.json`. That enum
   requires `REFERENCE_NOT_FOUND` for untyped references. SDKs follow the task document
   until the two are reconciled.
4. **Configuration identity.** Is `consumer_id` in the configuration key the right
   general boundary, or should both SDKs use account-only identity with distinct
   internal accounts per caller?
5. **Retained adjustment rows.** Keep JS's adjustment rows under `rows_v1`, or drop them
   in favour of the protocol's delta-only adjustments (Stage 3)?
6. **Python-only stores.** Does `reporting_inline_objects` (content-addressed source
   staging) and Python's provisional-observation payload storage converge onto the
   shared row store, or stay outside the shared contract?
