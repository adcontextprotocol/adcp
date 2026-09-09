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

The existing provision and deploy paths above establish only the PostgreSQL
ledger boundary. They do not enable a matched-v4 paid evaluation. Although the
deploy gate can stage a non-secret `ADDIE_MATCHED_V4_MERGE_SHA` for its verified
SHA, do not invoke `runAuthorizedAddieMatchedV4Execution`: the explicit entry
point is intentionally non-runnable until the separate evidence prerequisite
below is implemented and reviewed. The normal public surface remains plan-only;
the paid authority rejects before it opens the database or constructs a
provider adapter.

## Evidence and settlement prerequisites for the 43-cell evaluation

The 43-cell screening and its bounded full continuation remain blocked. The
repository has an append-only PostgreSQL execution ledger, and its release
workflows can produce keyless-cosign signatures and compare bytes before an
R2 upload. Those are useful building blocks, but neither is a sanctioned
immutable/WORM evidence sink for this evaluation: the R2 convention does not
attest Object Lock or equivalent retention, and a signature made after a
provider call cannot reserve durable evidence before that call.

Do not configure a GitHub Actions or Fly environment to work around this
gate. In particular, no `ALLOW_*` flag, caller-provided adapter, local path,
content-addressed R2 upload, or OIDC identity assertion authorizes paid
dispatch. The manual command itself intentionally refuses before it accesses
execution configuration or dispatches a provider request.

Before the gate may be replaced, a separate reviewed change must provide all
of the following:

1. An independently administered WORM/append-only evidence capability, or an
   independently signed durable receipt service, with a pre-dispatch
   reservation bound to the ledger reservation ID and exact merge/manifest.
2. A protected execution environment whose runtime database login inherits
   only `addie_matched_v4_runtime`, cannot assume the operator role, and has
   no direct evaluator-table DML.
3. Dedicated, spend-capped provider credentials that are not Fly credentials.
4. Provider-authoritative reconciliation retained independently from the
   evaluator: OpenAI organization costs for the dedicated project/time bucket;
   Google Cloud Billing detailed usage-cost export enabled before the run; and
   an Anthropic billing statement or account export covering the dedicated
   credential and window.

The evaluator records provider-returned response IDs and usage so a future
evidence service can join those records to the ledger. Its deterministic
pricing-profile value is an **estimate**, not provider-authoritative
settlement. Missing, late, aggregated, or non-reconcilable provider billing
evidence leaves the result `cost_settlement_pending`; it must not drive
promotion or rollout.
