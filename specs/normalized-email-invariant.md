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

Current `identity-db.ts` behavior (a real availability decision for database
review, not changed here): `withCredentialEventMutation` and the multi-credential
authority mutation retry 55P03/40P01 up to `CREDENTIAL_MUTATION_MAX_ATTEMPTS`, but
only while `mutationStarted` is false, i.e. for its own credential locks. The
595 gate fires inside the mutation callback (or inside confirmed credential
deletion, which has no retry loop), after `mutationStarted = true`. A 55P03 from
`pg_try_advisory_xact_lock(6827, 595)` there is rolled back and rethrown
unretried; the error propagates to the caller, so signed-webhook handlers are
expected to fail the delivery for provider redelivery and login/MCP callers keep
their existing error handling. Whether to add a bounded
whole-transaction retry is undecided and no retry is added by this change.

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
journal/uncertain-operation semantics. The frozen SQL header still records the
intended stack position 591 -> 592 -> 593 -> unpublished 594 -> 595, after
coordinator allocation audit.

Allocation status, as observed in this worktree (source inspection only; no
command was run for this refresh): main's file `591` is
`enable_verification_profile_comparisons`, which is unrelated to the email stack,
so the "591" in that header is a stack-position label, not a reference to main's
591. Versions 592, 593, 594 and 596 are absent; 595 is this file; main's highest
is 620 (`620_training_gcs_reporting`). The runner skips by applied-version
membership (`appliedVersions.has`) rather than by highest version, so mechanically
it can apply a late-filled 595 on a database that already applied higher versions.
That is not an allocation decision. The production 591 -> 596 allocation, the
coordinator serialization of the 592-596 range, and the human holds on the legacy
conflict inventory (see "Ownership and legacy policy") are unchanged and still
required before this migration may ship. Do not renumber or edit 595 to resolve
them here. Treating the runner's ability as release approval would be wrong.

The alias atomicity candidate and #7458/#7459/#7464 application containment must
be composed/reviewed in their intended order. No dependency migration is copied
into this production branch.

There is no honest automated down migration: dropping the four triggers and
their functions/table reopens the race and discards serialization evidence.
An authorized rollback requires drained writes and an explicit decision to
remove the integrity guarantee. Application rollback alone must retain 595.

## Production writer inventory

Line references were refreshed by source inspection of this worktree (main plus
the 595 stack); the original table referenced parent
`8d50c0e3c303391c8bb35c5042248eb847b06bb9`. The credential UPSERT/DELETE
writers that were previously inlined in login, WorkOS webhook/backfill and MCP
OAuth code are now centralized in `identity-db.ts`, so the 21 original statement
sites collapse to the 17 below. All are covered by the table triggers after
installation. Historical boot SQL runs before 595 and is covered by installation
preflight. Line numbers drift; re-inspect before relying on them.

| File | Lines | SQL writer |
|---|---|---|
| server/src/db/identity-db.ts | 675 | Single credential UPSERT (`upsertWorkosUserInCredentialEvent`); callers: login (`http.ts:7870`), WorkOS user events (`workos-webhooks.ts:457`, 983, 1089), MCP OAuth finalize (`oauth-provider.ts:282`), and the backfill helper `upsertWorkosUserUnlessConfirmedDeleted` (`workos-webhooks.ts:1381`) |
| server/src/db/identity-db.ts | 1116 | Confirmed credential DELETE with FK cascades (`deleteIdentityCredentialTransaction`); callers: WorkOS user deletion and backfill provider-404 cleanup (`workos-webhooks.ts:1500`) |
| server/src/http.ts | 7925 | Google credential import INSERT |
| server/src/http.ts | 7949, 8001 | Legacy Google alias INSERT / cleanup DELETE |
| server/src/routes/account-linking.ts | 298, 303, 308, 480 | Primary email UPDATE; alias DELETE/INSERT; email-link verification alias INSERT |
| server/src/routes/admin/users.ts | 940, 1095 | Fresh credential INSERT / existing provider credential import INSERT |
| server/src/db/user-merge-db.ts | 722, 730 | Alias duplicate DELETE / alias owner UPDATE |
| server/src/dev-setup.ts | 246 | Dev credential INSERT |
| server/scripts/setup-sandbox.ts | 226, 283 | Sandbox credential INSERT / cleanup DELETE |
| server/src/db/migrations/079_users_table.sql | 130 | Historical credential backfill UPSERT |

The user-merge alias UPDATE moves an alias to the merge primary; if the moved
alias's normalized email equals another credential's `users.email` (a case the
LOWER-based duplicate DELETE above does not cover), the trigger now rejects the
merge with 23505. That denial is the invariant working as intended; this change
adds no merge-time authority or repair logic.

The dynamic `users SET` builder in `addie/mcp/member-tools.ts:3115` allows only
headline, bio, city, linkedin_url, twitter_url, expertise and interests; it is
nevertheless protected. `user-merge-db.ts` has fixed-list dynamic UPDATE/DELETE
helpers; their current call sites do not target the two email tables. Migration
080 engagement and 210 slug procedures update users without email changes and
still participate. Migration 460 creates explicit identity bindings after user
insertion. Binding-only writes cannot change this exact-credential invariant.
No production COPY/MERGE/TRUNCATE writer was found; DB tests cover their seams.

Dependency writer movements are also covered: credential UPSERT/DELETE is now
centralized in `identity-db.ts` on this base (the #7459/#7464 movement);
`services/admin-credential-bind.ts` (#7464) is not present here, so its INSERT is
not inventoried; 592 adds UPDATE users and alias DELETE/UPSERT
in `services/email-mutation.ts`. #7458 removes legacy automatic Google alias
authority behavior. The new migration adds no authority inference.

## Application and composition limits

Database-seam tests execute the actual production INSERT/UPSERT strings scanned
from `http.ts` (Google import), `identity-db.ts` (the shared login, WorkOS
event/backfill and MCP credential UPSERT), admin create/import, dev setup and
sandbox code.
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
The atomic `ON CONFLICT DO NOTHING` alias insert followed by marking the token
verified belongs to existing PR #7499 / candidate 8847fc and is deliberately not
duplicated in this branch; `account-linking.ts` is untouched here.

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
