---
title: Matched v4 evaluator authority deployment
description: "Deploy the sealed Addie matched-v4 evaluator authority with external PostgreSQL role provisioning and a credential-isolated operator migration."
"og:title": "AdCP — Matched v4 evaluator authority deployment"
---

The matched-v4 evaluator ledger uses two externally administered PostgreSQL
roles. Before deploying migrations 584 and 585, an administrator must run the protected
provision workflow using the distinct, non-superuser `migration_principal`
(LOGIN, NOINHERIT, **no** CREATEROLE), passing a distinct ordinary runtime
principal. This is outside the application migration on purpose. PostgreSQL 16
gives a CREATEROLE role an implicit ADMIN edge to every role it creates, so a
migration principal must never create either evaluator role.

Before the protected workflow is allowed to run, a separately controlled DBA
connection must atomically create the static `addie_matched_v4_runtime` and
`addie_matched_v4_operator` NOLOGIN/NOINHERIT roles, grant the runtime role
directly to the ordinary app login, grant the operator role directly to the
distinct migration login, grant `USAGE, CREATE` on `public` directly to the
operator role, and grant `USAGE` (but never `CREATE`) on `public` to the
runtime role. `PUBLIC` must not have `CREATE` on that schema. This DBA
prerequisite must use `psql --single-transaction`. The same DBA setup must
create the ordinary `schema_migrations` ledger and grant the app principal
only the SELECT/INSERT access it needs; the runtime intentionally cannot
create even that pre-existing table.
The runtime must also have neither `USAGE` nor `CREATE` on `pg_toast`, and no
ACL on the evaluator tables' physical TOAST relations. Those internal
relations are custody data too; a direct grant or a view that depends on one
invalidates the evaluator attestation.
The checked-in bootstrap SQL is then intentionally read-only: it authenticates
as the migration login and rejects any missing, malformed, or cross-role
bridge. It does not create, repair, revoke, or grant roles. This prevents a
retry from acquiring a PostgreSQL 16 creator-admin edge.

The operator does not receive generic `schema_migrations` permissions. Apply
the evaluator SQL itself from the external operator boundary in order: 584,
then 585, and only then create an admission or run the ordinary application
migrator. Migration 585 refuses any custody evidence and replaces the local
per-response `settled` vocabulary with `response_usage_recorded`,
`estimated_cost_microdollars`, and `terminal_recorded_at`. The ordinary
migrator records neither external migration unless the transformed 585 schema
attests, so a 584-only deployment cannot be admitted.

On its legacy-shape path, 585 takes `ACCESS EXCLUSIVE` before it rechecks the
zero-evidence precondition, so an in-flight old-API write must finish before
the check and causes the transform to abort. Its already-transformed retry
uses `ACCESS SHARE`, preserving ordinary evaluator DML while it attests. The
legacy transform requires `READ COMMITTED` isolation; the protected workflow
sets it explicitly before any catalog query.

The advisory key `584585` is a cooperative serialization boundary, not a
database-wide mutex: every repository-supported evaluator bootstrap, retry,
admission, and external-migration-record path takes it before attesting and
holds it through commit. Operator-capable, migration-principal, DBA, and
superuser sessions are the trusted control-plane TCB and must use that protocol
for evaluator DDL or ACL changes. PostgreSQL cannot atomically exclude a raw
object-owner `GRANT`/`REVOKE` or function DDL command; atomicity is therefore
relative to the supported workflows. Any such out-of-protocol drift is rejected
by the next exact attestation and never silently repaired.

The secret-bearing `.github/workflows/provision-matched-v4-evaluator.yml` is
triggered only by a no-secret default-branch coordinator. It rejects foreign
repositories, non-default branches, and a coordinator SHA that is not current
`origin/main`; it re-fetches `origin/main` after protected approval and before
`psql`. Thus a workflow_dispatch-selected ref cannot supply the protected
workflow definition or execute SQL. Configure `MATCHED_V4_RUNTIME_PRINCIPAL`,
`MATCHED_V4_MIGRATION_PRINCIPAL`, and the reviewed
`MATCHED_V4_AUTHORITY_MANIFEST_SHA256` as protected environment variables. The
no-secret coordinator follows a successful `Build Check` for every `main`
push; it then inserts the one-use `operator_authorized` admission for the
verified main SHA and fixed operator gate. The deploy workflow is triggered
only after that protected provision workflow succeeds, so protected approval
cannot race or be polled past an already-fired deploy. If the protected run
fails, fix the reported prerequisite and push a new current `main` revision;
a stale SHA is deliberately not recoverable by manual dispatch. The protected
connection must authenticate as the configured migration principal, since that
is the only principal granted permission to assume the operator. Configure its
protected libpq connection fields only in that environment; the workflow passes
no credential on its command line. The separate DBA setup credential is never
configured for Fly, the application, or this repository workflow. Never set
them as Fly or application secrets, or in `fly.toml`. The Fly release command uses only its ordinary application
connection and fails closed with an actionable error until the external job has
completed. The protected deploy gate also stages
`ADDIE_MATCHED_V4_EVALUATOR_SCHEMA_REQUIRED=true` with the exact non-secret
merge SHA. Only that opt-in release path records migrations 584 and 585 after
the transformed schema attests; ordinary local, preview, and app migration
boots skip evaluator-only migrations and never re-attest their catalog after
they are recorded.

The enforced order is: successful Build Check → no-secret coordinator →
protected provision workflow → application release migration → application
rollout. The deploy workflow consumes the exact triggering protected workflow
run, verifies its successful provision job, and rechecks the release SHA
immediately before Fly use. Do not run 584 or 585 from the release command and do not
grant the application principal operator membership. If the provision job
times out or loses its runner before reporting success, inspect the relevant
transaction: it either rolled back or committed its complete bootstrap/schema
step. Re-run the same workflow input; role grants and the schema creation are
idempotent only from a complete state. Before retrying a rollout, verify that the app login can execute the
six scoped ledger functions, cannot
`SET ROLE addie_matched_v4_operator`, and
has no evaluator table or column privilege, and has `USAGE` but not `CREATE`
on `public`. The release migration independently verifies those
conditions, every canonical table shape and security-definer API definition,
the exact guards, the dedicated operator's complete object inventory, and that
neither tables nor functions are exposed to `PUBLIC`.

The normal `DATABASE_URL` remains the runtime connection. Its principal must
inherit only `addie_matched_v4_runtime`, must not be able to assume
`addie_matched_v4_operator`, and receives only the evaluator's narrowly scoped
SECURITY DEFINER functions—not table DML or admission creation.

`ADDIE_MATCHED_V4_DISPATCH_TIMEOUT_MS` optionally sets a per-provider-call
deadline. It is accepted only from 1,000 through 120,000 milliseconds (default
30,000). A deadline aborts the provider request, records `unknown_exposure`,
and reconciles the reservation; it never retries or counts a late response.

## GCS durable-evidence gate and human provisioning inventory

The paid constructor now obtains its evidence authority only from the sealed
Google Cloud Storage adapter. It first writes and verifies a unique,
create-only pre-dispatch reservation object; only then can it open the
PostgreSQL admission path or construct a provider adapter. The reservation
contains the exact selector fingerprint, stage cap, deployed merge SHA, sealed
authority-manifest digest, and evaluation version. A separately retained final
object includes the reservation object's bucket/name/generation/SHA-256 and
the artifact digest/evidence. Every post-dispatch refusal also attempts a
retained terminal-refusal object; it contains only one allowlisted reason code
(`paired_ci_gate`, `dispatch_timeout`, `response_usage_record_refused`, `intent_refused`,
`provider_response_invalid`, or `execution_refused`) rather than raw SDK or
provider exception text. Terminal writes bind the reservation to their first
completion or refusal identity. The issued/finalizing/uncertain/consumed state
machine rejects concurrent and cross-kind finalizers; a transient failed
write/readback retries that same deterministic create-only name and verifies an
existing 412 result, while an I/O deadline becomes `uncertain` and fails
closed rather than creating a conflicting terminal record. Every bucket
metadata lookup, object metadata lookup, generation-pinned readback, and save
has a 30-second adapter wall-clock deadline; the sealed Storage client has the
same finite HTTP timeout and retry total. Any malformed GCS response, digest
mismatch, missing future object-retention expiration, conditional-write
failure, deadline, or unlocked bucket refuses the run before dispatch or
prevents a successful result from being reported.

This relies specifically on [Cloud Storage Bucket Lock](https://cloud.google.com/storage/docs/bucket-lock): a locked positive retention policy prevents an object from being deleted or replaced before its retention age, and each protected object has retention-expiration metadata. The adapter checks `retentionPolicy.isLocked`, a positive period, a valid policy effective timestamp, and the written object's `retentionExpirationTime` is at least one year ahead. The one-year constant covers delayed provider billing reconciliation and a human audit window; it deliberately refuses a locked short-retention bucket. The protected verifier also requires a policy duration of at least `32,162,400` seconds (365.25 days plus a seven-day margin), so a policy that only exactly equals the runtime horizon cannot fail immediately after normal write/read latency; object readback remains the runtime authority. It writes with `ifGenerationMatch=0`; [GCS documents this as a conditional create that fails with 412 when a live object exists](https://cloud.google.com/storage/docs/request-preconditions). Object metadata alone is editable under a bucket retention policy, so the adapter verifies the returned object generation, MD5 of its bytes, and adapter-written SHA-256 metadata; a metadata assertion is never accepted as proof by itself.

Before a human enables execution, provision and review all of the following.

1. A dedicated Google Cloud project and evidence bucket, distinct from app,
   provider, and billing-export buckets. Set the retention period to the
   approved legal/compliance duration, then lock it permanently with Bucket
   Lock. This is irreversible; record the approval and exact bucket project
   number before locking. Do not enable object lifecycle rules that imply a
   shorter retention requirement.
2. A dedicated runtime workload identity/service account with only
   `storage.buckets.get`, `storage.objects.create`, and `storage.objects.get`
   on this one bucket and the `addie-matched-v4/v1/` object prefix through an
   IAM Condition. It must have no delete, update, list, bucket-policy, bucket
   retention-policy, IAM, project-owner, or service-account-admin authority.
   The narrow permissions mean a substituted bucket setting fails unless it is
   independently administered with the same constrained identity; the adapter
   still verifies its Bucket Lock and returned retained generation.
3. A distinct read-only verifier service account for the protected GitHub
   environment, with `storage.buckets.get` only. Configure GitHub OIDC/WIF for
   exactly that repository and the protected environment
   `matched-v4-durable-evidence`; restrict environment deployments to `main`,
   set required reviewers, and disallow self-approval. The checked-in verifier
   is triggered only by a `main` update to its own definition (then may be
   re-run from that trusted workflow run), never a dispatch-selected branch.
   Set its non-secret environment variables
   `MATCHED_V4_GCS_WIF_PROVIDER`,
   `MATCHED_V4_GCS_VERIFIER_SERVICE_ACCOUNT`, and
   `MATCHED_V4_GCS_EVIDENCE_BUCKET`. The checked-in
   `Verify matched-v4 durable evidence boundary` workflow only checks the
   current `main` checkout and bucket lock; it creates nothing and never calls
   a model provider.
4. Configure the production evaluator runtime's dedicated GCP workload
   identity credential outside the repository and set only the non-secret
   `ADDIE_MATCHED_V4_GCS_EVIDENCE_BUCKET` to the reviewed bucket name. Do not
   pass a bucket, Storage client, evidence receipt, or adapter through the
   execution caller. The sealed constructor has no such input key; test-only
   adapter capabilities likewise cannot be supplied to it.
5. Retain the existing separated PostgreSQL runtime/operator roles and the
   protected evaluator schema workflow above. Configure dedicated,
   spend-capped Anthropic, OpenAI, and Google model credentials separately
   from the GCS identity and from ordinary Fly credentials. Do not use an
   `ALLOW_*` flag, local path, R2 upload, GitHub identity assertion, or caller
   input as an evidence substitute.
6. Run the protected, provider-credential-free `Verify matched-v4 runtime build attestation`
   workflow from `main`. Its unprivileged build job builds one
   deterministic evaluator bundle and emits a commit-and-SHA-256 manifest.
   A clean protected job (with no checkout, package install, or build) verifies
   that SHA-256, asserts that its OIDC token subject names the protected
   `matched-v4-runtime-attestation` environment, and signs only that manifest
   with GitHub OIDC/Sigstore. It verifies the signature against the fixed
   repository/workflow identity and the Fulcio Deployment Environment extension
   OID `1.3.6.1.4.1.57264.1.23` with the exact environment value, then retains
   the bundle, manifest, and certificate bundle as **temporary staging**.
   GitHub public-repository artifacts expire after at most 90 days: approve
   promptly or dispatch a fresh current-main build, and do not treat an expired
   artifact as evidence. Before paid execution, a separately provisioned
   protected custody operation must transfer the bundle, manifest, and Sigstore
   bundle into the already-approved immutable WORM evidence custody. The paid
   runner must load only that retained copy, check its archive SHA-256 and exact
   source/build commit against the protected deployment's admitted SHA, verify
   the fixed workflow identity and OID/value again, and reject all caller-supplied
   SHA or artifact selectors. Protect
   the `matched-v4-runtime-attestation` environment with required reviewers,
   `main`-only deployments, and no self-approval. A later paid runner must
   download that exact artifact, verify its digest and Sigstore bundle again,
   and execute from the verified bundle; it must not accept a SHA, source path,
   provider, stage, or selector from a caller.
7. Before and after an actual run, obtain and retain the provider-authoritative
   native billing source independently of evaluator objects. These sources are
   aggregate reports, not response-level bills:

   - OpenAI organization costs are daily buckets grouped by `project_id` and
     `line_item`.
   - Anthropic usage/cost reports group by time, API key, workspace, and model.
   - Google Cloud Billing exports group by billing account, project, service,
     SKU, time, and resource metadata.

   Provision one dedicated project/workspace/API key per provider for this
   evaluation only. Before dispatch, record its reviewed identity and custody
   owner; do not share it with app, development, test, or another evaluation
   traffic source. After the run, a human must confirm from the scope's access,
   credential, and activity records that it had no extra or shared traffic for
   the entire UTC settlement window. If that isolation gate cannot be proved,
   aggregate provider cost cannot be compared truthfully and remains
   `cost_settlement_pending`.

   A future protected reconciliation adapter may normalize an authenticated,
   retained native source only into the checked-in
   `addie_matched_v4_provider_billing_settlement_receipt` contract. It captures
   the provider, provider-native granularity, native export identity and
   SHA-256 digest, dedicated scope identity, inclusive UTC coverage window,
   protected-custody settled-through determination, currency, and provider-reported
   **aggregate** microdollars. It may include a complete model breakdown for
   Anthropic or line-item breakdown for OpenAI only when that exact native
   export supplies it. Google breakdowns must be omitted until a separately
   reviewed SKU/resource-native breakdown contract exists. It must never
   synthesize, apportion, or label a per-response billed cost.

   Immutable evaluator response IDs and dispatch timestamps are
   execution-completeness evidence only: they show the planned execution
   completed inside the isolated scope/window, not a join to an aggregate bill.
   The protected adapter must bind that evidence to the dedicated scope, require
   coverage of the full run, and determine settlement finality at or after the
   covered window under a provider-specific source-lag/stability policy. That
   finality determination is protected-custody evidence, not a provider field
   fabricated from a bucket end or export observation time. It must require
   exactly one complete retained native export receipt per execution provider;
   it must reject a duplicate provider receipt or native export and
   non-USD/unsafe totals, and retain the authenticated source under independent
   custody. There is
   deliberately no production receipt-capability issuer yet; every
   raw/caller-constructible receipt and every current execution report remains
   `cost_settlement_pending`.
   Do not infer cost from tokens, a dated price profile, or a manually supplied
   total.

Do not run `npm run eval:addie-matched-v4-authorized` from a local checkout:
it deliberately refuses, because `ADDIE_MATCHED_V4_MERGE_SHA` alone cannot
prove that the executing source is the admitted deployment. The protected
runtime-attestation workflow is now the prerequisite for a paid runner; no
workflow in this change receives provider credentials or invokes a provider.
When a separately reviewed paid runner is provisioned, it must verify the
retained runtime bundle immediately before execution and expose spend-capped
credentials only to that verified process. It must accept neither a provider,
bucket, evidence capability, SHA, stage, nor admission selector from a caller,
and may emit only the non-authorizing report projection after retained evidence
has been verified. Cost-aware screening or promotion remains blocked unless a
future, separately reviewed protected reconciliation system establishes its
own authority; this checked-in contract cannot do so.

Run the GCS integration test only after the preceding approval and credentials
exist: `ADDIE_MATCHED_V4_GCS_INTEGRATION=true` plus the runtime GCS credential
and bucket setting. It writes two deliberately retained test records and never
deletes them; it does not open PostgreSQL or call a model provider. The normal
unit suite is deterministic and makes no network call.

The evaluator records provider response IDs and usage, and stores the dated
pricing calculation only as `estimated_cost_microdollars`. It is an
**estimate**, not provider-authoritative settlement. Aggregation
does not make billing unusable; it requires the isolated dedicated scope and a
complete settled UTC window described above. Missing, late, shared-scope,
duplicate, non-USD, unsafe, or unverifiable billing evidence remains
`cost_settlement_pending`. No estimate or receipt projection may unlock
cost-aware screening, promotion, rollout, or an exact per-response cost claim.
