# Shared SDK persistence: storage interface and digest code

**Status:** Design record. Reference-SDK persistence only; no new protocol requirements.
**Date:** 2026-10-14
**Scope:** Official JavaScript and Python SDKs. Reliable Reporting row storage.

## Summary

The SDKs share two things:

1. **A narrow storage interface.** Write a revision's rows. Read rows by revision ID and
   page. Retire a period. Adopters can plug their own storage behind it.
2. **The digest code.** RFC 8785 (JCS) row encoding and the revision content digest, pinned
   across both SDKs by golden fixtures.

Everything else is each SDK's own implementation. Revision headers, the change feed and
all coordination stay in PostgreSQL. Row bytes live in PostgreSQL or in an object store.
A warehouse gets a derived copy that is never read for serving or verification.

This document records the design the SDKs ship. It is not a storage-engine specification.
The JavaScript SDK ships the supported implementation (§3). The Python SDK implements
the same interface and encoding behind its own store.

## What was dropped

The first version of this proposal went further. After
[KonstantinMirin's review](https://github.com/adcontextprotocol/adcp/pull/7996#pullrequestreview-5486238393)
and [our reply](https://github.com/adcontextprotocol/adcp/pull/7996#issuecomment-6135334971),
these are gone:

- **Stage 3.** The shared Core layout, the migration runners, the cutover runbook and the
  transitional dual-key locks.
- **The shared account lock.** Each SDK keeps its own key. Under one writer SDK per ledger
  database (§5), the difference is harmless.
- **A shared idempotency store.** See §8.
- **The `persistence/` contract namespace.** That covers `contract.json`, the closed
  schemas, the catalog-manifest runners and the
  `adcontextprotocol.org/schemas/persistence/` `$id` namespace. A storage contract between
  two SDKs is not protocol. Values that have AdCP schemas reference them.
- **The Core decisions table, the revision header DDL and the cross-SDK qualification
  matrix.** They only served the shared layout.

The review's other points are adopted: stored values use their AdCP names (§2), the
interop test runs in CI (§5), and the change feed is described as the transactional
outbox pattern (§4).

## 1. Storage interface and shared digest code

### 1.1 Interface

The ledger keeps each revision's header in PostgreSQL: identity, finality, supersession,
the protocol content binding and a digest of the row manifest. Rows sit behind three
operations.

| Operation | Contract |
| --- | --- |
| Write a revision's rows | Create-only. Returns locators plus the objects this call created. Identical bytes already at a key are adopted and never recorded as created. Different bytes are a `CONTENT_CONFLICT`. |
| Read rows by revision ID and page | Returns rows verified against digests committed in PostgreSQL. Reads only the segments the page needs. |
| Retire a period | Tombstone the period, delete its external bytes at their recorded native versions, then delete its records (§6). Resumable. |

In JavaScript the interface is `ReportingRowStorageV1`, backed by
`ReportingRowObjectProviderV1` for object stores. Both operate on non-secret bindings that
host code allowlists. Credentials never reach the database, and the database cannot
redirect writes to a bucket the host did not configure.

Every operation has a deadline and honours cancellation. A timeout never means "nothing
was written". Operator error codes are stable and secret-free: `INVALID_INPUT`,
`CONTENT_CONFLICT`, `ROWS_INTEGRITY_FAILED`, `ROWS_UNAVAILABLE`, `ROWS_EXPIRED`,
`PROVIDER_UNAVAILABLE`, `DEADLINE_EXCEEDED`, `ABORTED`, `UNSAFE_BINDING`,
`STATE_UNAVAILABLE`.

Adopters may implement the interface over their own storage, usually their warehouse. An
open table format (Apache Iceberg, Delta Lake) fits here. They are not the default,
because they are heavy dependencies for sellers who want rows in PostgreSQL or a bucket.
Python may adopt `obstore` for its object providers. It does not replace the JavaScript
providers.

### 1.2 Digest code

- **Revision binding.** `revision_content_sha256` is SHA-256 over the RFC 8785 bytes of
  `{reporting_revision_id, row_count, control_totals, reporting_rows}`, as the protocol
  defines. Rows are in served order. `control_totals` uses the protocol shape
  `{name, value, value_type[, unit]}`. The `reporting-reconciliation/` compliance vector
  pins it, typed totals included.
- **Canonical row bytes.** Rows are stored as canonical JSONL: `JCS(row)` plus `\n`, in
  ordinal order. JCS escapes newlines inside strings, so `0x0A` only separates rows.
  Stored bytes are authoritative. Readers verify them and never re-serialize parsed values,
  so verification never depends on number parsing.
- **Chunks and segments.** A segment is up to 500 rows. A chunk is up to 10,000 rows and
  8 MiB. A new chunk starts when the current one is full. Each chunk records its segment
  digests, and the header's `row_manifest_sha256` covers the ordered chunk manifests.
- **Envelope reconstruction.** JCS sorts the envelope keys, so a verifier streams
  `{"control_totals":` + totals + `,"reporting_revision_id":` + id +
  `,"reporting_rows":[` + rows joined by `,` + `],"row_count":` + n + `}` without parsing
  a row.
- **Write-side number domain.** Writers refuse non-finite numbers, integers beyond
  ±(2^53 − 1), lone surrogates and duplicate object keys. Readers accept any RFC 8785
  number.
- **Fixtures.** `row-encoding.ts` and `row_encoding.py` produce byte-identical chunks,
  manifests and digests for every golden fixture. The fixture file lives in the JavaScript
  SDK. The Python SDK copies it byte for byte.
- **Compression.** Optional `gzip`, one member, with the stored size and digest checked
  before inflating. Objects are never stored with `Content-Encoding: gzip`.

## 2. Stored values use their AdCP names

Every stored value that has an AdCP counterpart uses its name, type, pattern and bound.

| Stored value | AdCP definition |
| --- | --- |
| `object_ref` | Destination-relative object reference, 1 to 1024 characters (`reporting-file-object-ref.json`) |
| `native_version_ref` | Decoded native version, 1 to 1024 characters (`reporting-native-version-ref.json`) |
| `size_bytes` | Stored object size, after compression (`reporting-file-entry.json`) |
| `canonical_size_bytes` | Uncompressed canonical bytes of a chunk. The digest-pinned manifest verifies against it. |
| `content_size_bytes` | Size of the content `content_sha256` covers. For a revision it includes the envelope. |
| `format`, `algorithm` | `jsonl` and `adcp_jcs_rows_v1` (`reporting-file-manifest.json`, `reporting-canonicalization-contract.json`) |
| `period_date` | `YYYY-MM-DD`, the period start's calendar date in its `source_timezone`, as one key segment |

A missing, unknown or non-IANA `source_timezone` fails the write. The BigQuery sink's
`period_date` column uses the same helper. `revision_content_sha256` and every other
buyer-visible value are unchanged.

**Renamed in SDK 16.** `object_key`, `native_version`, `physical_byte_count`,
`byte_count`, `canonical_byte_count` and `encoding` became the names above. SDK 16 ships
as `16.0.0-beta.1` on the `beta` tag. JavaScript #3226 and #3227 made the change, and
Python #1485 mirrors it. It was one breaking migration, shipped before any adopter
activated row storage. See the
[migration note](https://github.com/adcontextprotocol/adcp-client/blob/main/docs/migration-reporting-row-storage-alignment.md).

## 3. Supported JavaScript implementation

These are supported SDK code, not example code. They sit under experimental subpaths, so
breaking changes ship in minor releases with a migration note. See the
[stability policy](https://github.com/adcontextprotocol/adcp-client/blob/main/docs/guides/REPORTING-STABILITY.md).
Adopters pin `~16.0.0`. Demoting them to examples would push every adopter into owning a
fork.

- **The PostgreSQL ledger store** (`@adcp/sdk/reporting/ledger`). Headers, locks, leases,
  gapless revision numbering, lifecycle compare-and-set and the change feed.
  PostgreSQL stays the only coordination database. Object stores and warehouses hold
  bytes and never run the ledger.
- **Row storage providers.** GCS, S3 and Azure Blob (`/gcs`, `/s3`, `/azure`), plus a
  filesystem provider for tests and single-host development.
- **The change feed** (§4).
- **The BigQuery warehouse sink** (`/bigquery`, §3.2).

Python implements the same interface and encoding over its own tables, and ships GCS, S3
and Azure extras (`adcp[reporting-gcs|reporting-s3|reporting-azure]`).

### 3.1 Object providers

| Provider | Create-only write | Native version recorded |
| --- | --- | --- |
| GCS | `ifGenerationMatch: 0` | generation |
| S3 | `If-None-Match: *` | version ID (bucket versioning required) |
| Azure Blob | `If-None-Match: *` | version ID (blob versioning required) |
| Filesystem | temp file, `fsync`, `link()` | inode and mtime (not write-unique) |

- **A native version identifies one write.** Reads and deletes pin to the recorded
  version, so a delayed delete cannot remove a later object at the same key. An ETag does
  not qualify, because an identical re-upload has the same one. The probe refuses an
  unversioned S3 bucket or Azure container with `UNSAFE_BINDING`.
- **Unique object keys are required everywhere.** Every writable key template must
  include `{revision_key}`. Old templates stay usable for reads and retirement through a
  `readOnly` binding.
- **Version-pinned `stat`.** Adopting an existing object at commit checks that it exists
  at the recorded version with the recorded size. It does not re-download the object under
  the account lock. Providers without `stat` fall back to a full read.
- **Bucket policy.** Row buckets are private, with uniform bucket-level access on GCS.
  The probe refuses any lifecycle rule that can delete live rows (§4.2), and repeats the
  check periodically.
- **Keys.** Rendered keys begin with the binding's owned prefix and its `namespace_key`.
  Account IDs appear only as a hash. The rendered key is stored, never re-derived.

### 3.2 BigQuery warehouse sink

The sink is a derived, non-authoritative copy of committed revisions. Table names,
columns, types, partitioning and retention are the adopter's.

- Each tick reads the next range from the change feed, reads rows through the verified
  reader and runs one load job per table. Job IDs derive from the sink and that range, so
  a replay after a crash under the same IDs is refused by BigQuery.
- Fixes in #3197, #3239 and #3251: overlapping plans are fenced, a job is looked up by ID
  before uploading, a load that outlasts its deadline converges, and the cancel path is
  removed.
- A reference `current_rows` view keeps each obligation's leaf revision: the official
  revision, otherwise the latest snapshot. Cumulative snapshots double-count spend when
  summed across revisions.
- The sink registers as a change-feed consumer. If it stays down past
  `max_feed_hold_days`, its hold is released and the warehouse lacks those revisions. The
  sink reports them as missing, never skips them silently.
- An adopter that wants a table format can instead put Iceberg or Delta Lake behind the
  storage interface, and BigQuery reads those as external tables.

## 4. Change feed and write intents

### 4.1 Change feed: the transactional outbox

Each ledger record writes a change row in the same transaction. Registered consumers read
those rows by cursor. This is the transactional outbox pattern, implemented once, with
retention-aware consumer horizons. PostgreSQL logical replication would add replication
slots and decoding plugins for every adopter to operate.

- **Ordering.** `nextval` is taken after the account lock, so per-account `seq` order
  equals commit order. The deployment-wide feed orders by `(xid, seq)` and returns only
  changes whose transaction precedes every transaction still in flight.
- **Account-feed truncation.** An account page ends before the first change whose `xid` is
  at or above the reading snapshot's `xmin` (#3228). The page is cut there, not filtered,
  because a filter could hand out a later change and skip an earlier one. Any older open
  transaction on the cluster holds both feeds back, so an empty page means caught up or
  held back.
- **Durable consumers.** A registered consumer holds back change pruning and period
  retirement until it has passed the period's changes. Both holds share one cap,
  `max_feed_hold_days`, measured from the consumer's last update.
- **Expired cursors.** A cursor older than `change_retention_days` fails with
  `CURSOR_EXPIRED`. The consumer resynchronizes from `listCurrentRevisions`.
- **Buyers** keep the protocol's `changes_checkpoint` and `changes_after`, which project
  from the same table.

### 4.2 Write intents and sweeps

A lifecycle rule cannot replace the write intent. It cannot tell an abandoned upload from
a committed object under the same prefix, and object stores have no rename to separate
staging from committed. Deleting by age would remove live rows. Tolerating orphans is a
cost leak. The GCS probe refuses lifecycle `Delete` rules that can match live objects for
this reason.

1. **Replay check.** If a header for this revision ID and content exists, return it.
2. **Open the intent.** Upsert `(binding, revision, content)` with an owner token and an
   expiry. A writer takes over an expired `open` intent, never one in `sweeping`.
3. **Upload** create-only, outside any transaction. Record the objects this call created.
4. **Commit** under the account lock: insert the header and manifest, then delete the
   intent where `state = 'open'` and the owner token matches. If that delete matches
   nothing, the transaction fails.

A crash or lost lease leaves an intent. The sweep moves an expired `open` intent with no
committed header to `sweeping` under the account lock. It then deletes only the objects
that intent created, at their recorded versions. Adopted objects are never swept. Failed
retirements and sweeps back off per item, so a stuck item never starves the rest (#3228).
A sweep skips intents whose binding this host does not configure, and counts them.

With unique object keys required, the cross-row-set object lock can go. It stays for now
because header-only revisions (§6) share chunks within an obligation. Each SDK takes
`pg_advisory_xact_lock(hashtextextended('adcp-reporting-object:' || binding_id || ':' || object_ref, 0))`
for every external row-object delete and every commit that adopts an existing object.
Under that lock, a delete proceeds only if no `live` or `unavailable` row set and no other
open intent references the same binding, key and native version. Removing the lock is a
follow-up.

## 5. Concurrency: one writer SDK per ledger database

**A ledger database has exactly one writer SDK.** Mixed-SDK writers on one account are
unsupported. A deployment that runs both SDKs, such as a JavaScript adapter fleet and a
Python seller, gives each its own database.

The reason is the account lock. The SDKs take different keys:

- JavaScript: `hashtextextended('adcp-reporting-account:' || account_id, 0)`
  (`postgres.ts`).
- Python: `hashtext('adcp.reporting:' || account_id)` (`pg.py`).

Account readers of the feed order by `seq` and rely on the lock to keep `seq` in commit
order. Under two keys that fails. In a reproduction on
[adcp-client-python#1457](https://github.com/adcontextprotocol/adcp-client-python/issues/1457),
a Python append took `seq` 1 and a JavaScript append took `seq` 2. JavaScript committed
first, and an account reader skipped `seq` 1 permanently.

The account-feed truncation guard (§4.1) is defense in depth. It narrows the window and
cannot close it for every interleaving of a writer that takes a different lock key. It
does not make mixed writers supported.

The interop test is the format gate. Each SDK's chunks must verify in the other, against
one database and one bucket. Python CI builds JavaScript `main` and runs it on reporting
changes and on pushes to `main`. It fails rather than skips when the JavaScript side is
missing (#1481). Passing it does not make mixed writers supported.

## 6. Retention

Retention is period-aligned and protocol-aligned.

- **Retained as a unit.** A revision's header, manifest and rows are kept for at least
  `status_retention_days`. The anchors follow #8100: a revision's own `created_at`, its
  successor's once superseded, and for an official revision its newest adjustment. A period
  retires only after the latest of its end, its newest revision and its newest adjustment
  plus the window. Every superseded snapshot is kept. SDKs may offer opt-in snapshot
  compaction, which #8100 permits (#3200).
- **Holds keep the whole period.** A live materialization, or a live registered consumer
  that has not passed the period's changes, holds the entire period until the hold clears
  or reaches its cap. Rows are never kept while the records that locate them are deleted.
- **A shorter window is advertised, not configured away.** A row retention shorter than
  the advertised `status_retention_days` is non-conformant, and the SDK refuses it.
- **Unchanged pulses become header-only revisions.** When a pulse's rows are byte-identical
  to the current revision's (`row_manifest_sha256` matches), the producer mints a normal
  snapshot with a new ID, number, `observed_at` and digest. It shares the previous
  revision's chunks. Skipping the pulse would freeze freshness, and the protocol has no
  other way to advance `observed_at`.
- **Reference-checked deletes.** A delete skips any external object that another row set
  still references (#3204). Sharing never crosses obligations.

| Record | Retained | Then |
| --- | --- | --- |
| Row bytes, headers, manifests, statuses, receipts and lifecycle state for a period | `max(status_retention_days, ledger_record_retention_days)` after the period expires, plus holds | Retired together |
| Per-obligation tombstone (IDs, digests, revision count, `pruned_at`) | Indefinitely, about 200 bytes | Refuses replays that would resurrect pruned IDs |
| Change rows | `change_retention_days` (default 30), extended by consumers up to `max_feed_hold_days` | Deleted. Older cursors get `CURSOR_EXPIRED` |

**Retiring a period** is one ordered, resumable sequence:

1. Under the account lock, re-check every hold, write a `retiring` tombstone and mark the
   period's row sets `pruning`. Exact reads now answer as expired.
2. Delete the period's recorded object versions. A failure leaves every locator intact.
3. Delete the period's PostgreSQL bodies, manifests, headers and records, mark the
   tombstone `retired`, and record the retirement in the change table.

Python's append-only guards protect some records, such as reconciliation records. A period
that carries them is marked `protected` and is not retired, though its row bytes can still
be freed. The guards are an audit-model decision for the Python maintainers.

## 7. Wire mapping and protocol questions

- **Inside the retention window**, `ROWS_UNAVAILABLE` and `ROWS_INTEGRITY_FAILED` never
  become a not-found and never release unverified rows. An exact read returns
  `SERVICE_UNAVAILABLE`, and the obligation can no longer be `healthy` or `complete`.
- **Outside the window**, `ROWS_EXPIRED` returns the same non-disclosing not-found as an
  unknown ID. The revision leaves every protocol projection, and
  `scope.ledger_retained_from` advances past its period.
- **Buyers** see collapsed codes, so they cannot probe whether an object exists.
- **Paging.** Delivery pages map to segments. `total_count` comes from the header. Cursors
  carry `row_location_version` and re-resolve if rows move.
- **Metadata-only paths** (producer, lifecycle, status ingest, planning) never read rows.

Resolved protocol questions:

- **Superseded-snapshot content (#8081, resolved by #8100).** Metadata is kept for every
  revision. Content is kept for the current revision, the one it supersedes, superseded
  snapshots within their recovery grace, and revisions named by the caller's receipts or
  status statements.
- **Unreadable retained revision (#8082, resolved by #8099).** The issue code is
  `REVISION_UNREADABLE`. While it is open, an authorized exact read returns
  `SERVICE_UNAVAILABLE`, never not-found.
- **Not-found error code (#8083, resolved by #8085).** Unknown, unauthorized and expired
  revisions return `REFERENCE_NOT_FOUND`.

Open protocol item:

- **HTTPS push (#8149).** HTTPS push to a buyer endpoint authenticates as the seller and
  never holds a buyer secret. Row push is `reporting_webhook`. Object push is
  `file_transfer`.

## 8. Adoption plan

| Stage | Deliverable | Status |
| --- | --- | --- |
| 0. Contracts | The canonical row encoding, the digest rules and golden fixtures, byte-identical in both SDKs. | Done |
| 1. JavaScript | Row storage, providers, retention, the change feed and the BigQuery sink: #3145, #3146, #3152, #3155, #3157, #3159, #3160, #3161, #3163, #3164, #3165, #3166, #3167, #3168 and #3169. | Done |
| 2. Python | Row storage over the same encoding: adcp-client-python #1458 to #1476. | Done |
| Alignment | AdCP stored names and the `period_date` rule: JavaScript #3226 and #3227, Python #1485. Retirement and sweep backoff and the account-feed guard: JavaScript #3228, Python #1482 and #1483. Interop test in CI against JavaScript `main`: Python #1481. | Done |
| Hardening | BigQuery sink fixes: #3197, #3239, #3251. Experimental subpaths: #3238. | Done |
| 4. Idempotency | Each SDK implements the idempotency state machine behind its own store. | Future |
| 5. Extensions | Managed delivery, receipts, notifications and outboxes. Each SDK implements them behind its own store. | Future |

Stages 4 and 5 need no shared layout. They would only need one if two SDKs wrote the same
tables, and §5 rules that out. Behavior comes from the protocol's
[security and idempotency rules](../docs/building/by-layer/L1/security.mdx), not from a
shared schema. Each SDK keeps its own tables and migrations. The same constraint applies
to any store both SDKs would write.
[DR-0021](../governance/decisions/DR-0021-idempotency-ledger-outlives-resource.md) is
related but still proposed. This document does not ratify it.

## 9. Alternatives considered

- **BigQuery as the ledger database.** Rejected. The ledger needs row locks, `SKIP
  LOCKED` leases, gapless numbering under concurrency and a change feed committed with
  each record.
- **BigQuery as the authoritative row store.** Deferred. It needs mandatory
  re-verification, and point reads take about a second. The sink gives analysts typed
  tables without those costs. A `bigquery` row store can sit behind the interface later.
- **Pointing at rows the adopter already keeps in a warehouse.** Deferred. Landing tables
  are merged or overwritten, which breaks earlier revisions, and a selector that misses
  its account filter mints another tenant's evidence.
- **Replacing write intents with lifecycle rules.** Rejected (§4.2).
- **A shared persistence package and a second schema manager.** Dropped (see above).
