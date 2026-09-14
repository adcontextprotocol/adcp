# Normalized credential email invariant (migration 595)

This is one #6827 integrity/recovery slice. It is not #6827 closure. Historical
exact reversal, identity/authority provenance, callback containment, and provider
reconciliation remain separate work. An alias is not an authentication source;
the #7458 containment must remain in the deployment stack.

## Ownership and legacy policy

The owner is the exact `workos_user_id`, never an identity inferred from email.
For each JavaScript-normalized email, at most one credential may occur across
`users.email` and `user_email_aliases.email`. Canonical siblings are different
owners. One credential row may overlap with one alias belonging to that exact
credential: migration 592 updates the credential before deleting its own alias
during a primary-email swap. Two aliases with the same normalized email are
rejected even if their owners match. Verification state does not relax ownership.

Migration 595 does not normalize stored values, select a winner, move bindings,
delete aliases, or change membership/credential provenance. Preflight runs under
both table locks and reports conflicting raw rows, credential IDs and normalized
keys. A conflict aborts the migration transaction; all original rows remain.
The exception includes the total and the first 20 conflicting keys. Obtain the
complete inventory using explicitly supplied read-only credentials:

```bash
DATABASE_URL=... npx tsx server/src/scripts/audit-normalized-emails.ts
```

The script requires Unicode 17.0 and refuses an RLS-filtered result. It uses a
read-only repeatable-read transaction and reports every overlap,
including permitted exact-credential overlaps. Binding IDs are evidence only.
Exit status 1 means conflicts exist. Protect the output as account data. No live
inventory was performed for this candidate. Case/whitespace variants, prior
Google/admin duplication, rebinding and uncertain provider operations can all
block installation. Support must establish provenance and authorize individual
repairs; this migration cannot determine which historical row is correct.

## Database protocol

The two tables each have an `ENABLE ALWAYS` BEFORE STATEMENT lock trigger and
AFTER STATEMENT check trigger on **all** INSERT, UPDATE, DELETE and TRUNCATE.
This covers COPY, UPSERT, MERGE, cascades, direct SQL, dynamic SQL, future callers,
and another trigger changing email during an unrelated-column UPDATE. There is
no trigger-depth exemption. Neither check is deferred by SET CONSTRAINTS.

1. Acquire `pg_try_advisory_xact_lock(6827, 595)`. This two-int namespace is
   disjoint from 592's one-bigint hashed credential locks. Failure raises 55P03.
2. Physically increment the singleton `normalized_email_serialization.version`;
   require exactly one returned row. Missing/suppressed storage fails closed.
   Under REPEATABLE READ/SERIALIZABLE, a writer with an older snapshot fails
   with 40001 when another invariant transaction has changed the singleton.
3. Run the requested statement, including its row triggers and FK effects.
4. Check the persisted representations with a VOLATILE function and bytewise
   `COLLATE "C"` grouping. Conflicts raise 23505 / `normalized_email_owner`.
5. Retain the lock through commit/rollback, including deferred trigger execution.

The transaction lock prevents another participating writer between check and
commit. VOLATILE SPI queries see new committed snapshots at READ COMMITTED;
the singleton write closes the stronger-isolation stale-snapshot gap. Opposite
email order, table order, and multi-statement order add no advisory wait edge:
contenders abort immediately. A caller may retry the **entire rolled-back local
transaction**, with a fresh snapshot and a bounded attempt count. There is no
automatic trigger retry and no provider retry authorization. Never retry an
uncertain external operation without its durable reconciliation protocol.

This is not a claim that arbitrary PostgreSQL code is deadlock-free. Explicit
row/table locks and TRUNCATE's relation locks may deadlock before these triggers
run. PostgreSQL aborts a participant without breaking the invariant. Installation
also uses NOWAIT table locks; drain writers and retry installation on 55P03.

The global gate and full-table validation deliberately trade throughput for a
small, auditable protocol. Profile/name updates and zero-row statements also
participate. Measure contention and scan cost at realistic volume before rollout;
55P03 is a fail-closed availability response, not successful synchronization.
An unrelated advisory user deliberately choosing the same two-int key can cause
contention but cannot admit a conflicting email.

## Exact normalization

`normalized_credential_email(text)` implements Node's `trim().toLowerCase()` for
PostgreSQL UTF-8 text, pinned to Unicode 17.0 (the production Node 24 toolchain).
It uses generated locale-independent lowercase mappings, ECMAScript whitespace,
the U+0130 expansion, and context-sensitive final sigma on the original input.
Case_Ignorable takes precedence over Cased for overlapping Unicode properties.
No PostgreSQL locale-specific LOWER, Unicode casefold, NFC, IDNA, or Google
mailbox heuristic determines ownership. NUL/lone surrogates are outside the
PostgreSQL text domain. Stored email strings remain unchanged.

```bash
node scripts/generate-email-normalization.mjs --check
```

The generator and parity integration test reject Unicode-version drift. A Node
upgrade changing these semantics requires a new migration and conflict inventory;
do not rewrite a deployed immutable normalization function or released migration.
The pre-existing `LOWER(email)` alias index is retained: it may reject additional
Unicode combinations that JavaScript distinguishes. That conservative historical
restriction is not a bypass of the new invariant.

## Function custody and operational order

All data-reading/mutating enforcement functions are SECURITY DEFINER with fixed
`search_path=pg_catalog`, schema-qualified application relations, and
`row_security=off`. PUBLIC cannot call the internal check/trigger functions or
write the serialization table. Trigger execution still protects DML roles that
cannot read aliases or the singleton. The owner must have full visibility;
`row_security=off` fails if RLS would otherwise hide rows. Do not grant runtime
DDL ownership, trigger-disabling capability, or function replacement rights.
Superusers and object owners can intentionally bypass enforcement; no trigger
scheme protects against a database administrator replacing it.

ALWAYS triggers enforce the email invariant in replica mode. They do not make
592's ordinary triggers or foreign keys replica-safe. Logical replication and
restore require a reviewed ordering/validation procedure. Restore into an
isolated database, retain all raw evidence, run the inventory and install or
revalidate enforcement before admitting application traffic. Restoring a dump
that creates triggers after COPY does not prove the copied data is conflict-free.
Never disable triggers on an active application database to import conflicts.

Migration 595 is self-contained against main's current schema and is rerunnable
under the repository runner. It does not redefine any 592 function or alter its
journal/uncertain-operation semantics. Operational stack position is strictly
591 -> 592 -> 593 -> unpublished 594 -> 595, after coordinator allocation audit.
The alias atomicity candidate and #7458/#7459/#7464 application containment must
be composed/reviewed in their intended order. No dependency migration is copied
into this production branch.

There is no honest automated down migration: dropping the four triggers and
their functions/table reopens the race and discards serialization evidence.
An authorized rollback requires drained writes and an explicit decision to
remove the integrity guarantee. Application rollback alone must retain 595.

## Production writer inventory

Line references are to exact parent `8d50c0e3c303391c8bb35c5042248eb847b06bb9`.
All 21 statements below are covered by the table triggers after installation.
Historical boot SQL runs before 595 and is covered by installation preflight.

| File | Lines | SQL writer |
|---|---|---|
| server/src/http.ts | 7758, 7807 | Login UPSERT and Google credential import INSERT |
| server/src/http.ts | 7828, 7880 | Legacy Google alias INSERT / cleanup DELETE |
| server/src/routes/account-linking.ts | 298, 303, 308, 480 | Primary email UPDATE; alias DELETE/INSERT; verification alias INSERT |
| server/src/routes/workos-webhooks.ts | 448, 506 | WorkOS user event UPSERT / DELETE with FK cascades |
| server/src/routes/workos-webhooks.ts | 1430, 1552 | Global/per-org backfill UPSERT / provider-404 cleanup DELETE |
| server/src/routes/admin/users.ts | 939, 1094 | Fresh credential INSERT / existing provider credential import INSERT |
| server/src/mcp/oauth-provider.ts | 271 | MCP OAuth credential UPSERT |
| server/src/db/user-merge-db.ts | 714, 722 | Alias duplicate DELETE / owner UPDATE |
| server/src/dev-setup.ts | 246 | Dev credential INSERT |
| server/scripts/setup-sandbox.ts | 226, 283 | Sandbox credential UPSERT / cleanup DELETE |
| server/src/db/migrations/079_users_table.sql | 130 | Historical credential backfill UPSERT |

The dynamic `users SET` builder in `addie/mcp/member-tools.ts:3024` allows only
headline, bio, city, linkedin_url, twitter_url, expertise and interests; it is
nevertheless protected. `user-merge-db.ts` has fixed-list dynamic UPDATE/DELETE
helpers; their current call sites do not target the two email tables. Migration
080 engagement and 210 slug procedures update users without email changes and
still participate. Migration 460 creates explicit identity bindings after user
insertion. Binding-only writes cannot change this exact-credential invariant.
No production COPY/MERGE/TRUNCATE writer was found; DB tests cover their seams.

Dependency writer movements are also covered: #7459/#7464 centralize credential
UPSERT/DELETE in `identity-db.ts`; #7464 adds an INSERT in
`services/admin-credential-bind.ts`; 592 adds UPDATE users and alias DELETE/UPSERT
in `services/email-mutation.ts`. #7458 removes legacy automatic Google alias
authority behavior. The new migration adds no authority inference.

## Application and composition limits

Database-seam tests execute the actual production INSERT/UPSERT strings from
login/Google, WorkOS event/backfill, admin create/import, MCP and sandbox code.
Those tests prove storage enforcement. They do not claim provider ordering:
base login/MCP still catch local persistence errors and continue authentication,
and base/admin #7464 preflight only checks users with LOWER(email). An alias
conflict can therefore be denied after provider creation; durable compensation
and reconciliation remain required. New route-level preflight/containment is a
separate stack concern. No non-test database or real provider is used here.

Migration 595 alone cannot prove an alias verification INSERT/UPDATE happened
when an unrelated trigger returns NULL. Exact candidate 8847fc performs the
required rowCount/readback checks; its production verification flow has no
required audit INSERT. Its existing test-only audit/storage faults are included
in composition validation. Main's legacy verifier remains outside this fix.

`normalized-email-composition.test.ts` intentionally runs only with
`ADCP_EMAIL_COMPOSITION=true` in an isolated checkout containing published #7463
plus the exact candidate route. It checks these git blob hashes before execution:

- migration 592: `e726bbaaa214105df6a922773f7c208bb4919966`
- candidate route: `ab283d29b754dd083d31c645a49ef56fbb94e2da`
- recovered existing candidate tests: `0cef113161f9bed39a9c52e1f67d0f555771098b`

The composition pauses the actual candidate after its users predicate, commits
an independent competing credential INSERT/UPDATE, then resumes: verification
fails, token remains pending and no alias commits. In the reverse ordering,
the credential writer fails and only verification succeeds. A READ COMMITTED
predicate is no longer the invariant's serialization boundary.

Mounted primary-email composition also proves that local preflight denial makes
no provider calls, and that common-lock denial during local apply/compensation
retains 592's durable reconciliation state. Retrying that unresolved operation
does not repeat provider calls.

Three old dependency tests deliberately create rows that 595 now prohibits:
two physically ambiguous historical-alias fixtures and a same-email fingerprint
fixture on another credential. Their pre-595 behavior and post-595 setup denial
must be classified separately; they are not grounds to disable production
enforcement. Legacy-conflict retention is tested at migration preflight.
