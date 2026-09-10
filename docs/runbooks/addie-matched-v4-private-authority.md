---
title: Matched v4 evaluator authority deployment
description: "Deploy the sealed Addie matched-v4 evaluator authority with external PostgreSQL role provisioning and a credential-isolated operator migration."
"og:title": "AdCP — Matched v4 evaluator authority deployment"
---

The matched-v4 evaluator ledger uses two externally administered PostgreSQL
roles. Before deploying migration 584, an administrator must run the protected
provision workflow using the distinct, non-superuser `migration_principal`
(LOGIN, NOINHERIT, **no** CREATEROLE), passing a distinct ordinary runtime
principal. This is outside the application migration on purpose. PostgreSQL 16
gives a CREATEROLE role an implicit ADMIN edge to every role it creates, so a
migration principal must never create either evaluator role.

Before the protected workflow is allowed to run, a separately controlled DBA
connection must atomically create the static `addie_matched_v4_runtime` and
`addie_matched_v4_operator` NOLOGIN/NOINHERIT roles, grant the runtime role
directly to the ordinary app login, grant the operator role directly to the
distinct migration login, and grant `USAGE, CREATE` on `public` directly to
the operator role. This DBA prerequisite must use `psql --single-transaction`.
The checked-in bootstrap SQL is then intentionally read-only: it authenticates
as the migration login and rejects any missing, malformed, or cross-role
bridge. It does not create, repair, revoke, or grant roles. This prevents a
retry from acquiring a PostgreSQL 16 creator-admin edge.

The operator does not receive generic `schema_migrations` permissions. Apply
the evaluator SQL itself from the external operator boundary, then run the
ordinary application migrator. Migration 584 only verifies that externally
completed schema and records it in the normal migration ledger. This preserves
the normal migration owner/path for existing tables and later app migrations.

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
merge SHA. Only that opt-in release path records migration 584 after its full
schema attestation; ordinary local, preview, and app migration boots skip the
evaluator-only migration and never re-attest its catalog after it is recorded.

The enforced order is: successful Build Check → no-secret coordinator →
protected provision workflow → application release migration → application
rollout. The deploy workflow consumes the exact triggering protected workflow
run, verifies its successful provision job, and rechecks the release SHA
immediately before Fly use. Do not run 584 from the release command and do not
grant the application principal operator membership. If the provision job
times out or loses its runner before reporting success, inspect the relevant
transaction: it either rolled back or committed its complete bootstrap/schema
step. Re-run the same workflow input; role grants and the schema creation are
idempotent only from a complete state. Before retrying a rollout, verify that the app login can execute the
six scoped ledger functions, cannot `SET ROLE addie_matched_v4_operator`, and
has no evaluator table DML. The release migration independently verifies those
conditions, every canonical table shape and security-definer API definition,
the exact guards, and that neither tables nor functions are exposed to `PUBLIC`.

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
(`paired_ci_gate`, `dispatch_timeout`, `settlement_refused`, `intent_refused`,
`provider_response_invalid`, or `execution_refused`) rather than raw SDK or
provider exception text. Terminal writes use an issued/finalizing/consumed
state machine: concurrent finalizers are refused, while a transient failed
write/readback resets to issued and can retry by verifying an existing 412
conditional-create result. Any malformed GCS response, digest mismatch,
missing future object-retention expiration, conditional-write failure, or
unlocked bucket refuses the run before dispatch or prevents a successful
result from being reported.

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
   `matched-v4-durable-evidence`; set required reviewers and disallow
   self-approval. Set its non-secret environment variables
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
6. Before and after an actual run, obtain provider-authoritative billing
   evidence: OpenAI organization costs for the dedicated project/time window,
   Google Cloud Billing detailed usage-cost export, and an Anthropic billing
   statement or account export for the dedicated credential/window. Retain
   those reconciliations independently of the evaluator objects.

Run the GCS integration test only after the preceding approval and credentials
exist: `ADDIE_MATCHED_V4_GCS_INTEGRATION=true` plus the runtime GCS credential
and bucket setting. It writes two deliberately retained test records and never
deletes them; it does not open PostgreSQL or call a model provider. The normal
unit suite is deterministic and makes no network call.

The evaluator records provider response IDs and usage, but its dated pricing
profile is an **estimate**, not provider-authoritative settlement. Missing,
late, aggregated, or non-reconcilable provider billing evidence remains
`cost_settlement_pending` and must not drive promotion or rollout.
