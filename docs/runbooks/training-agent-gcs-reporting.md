---
title: Private training-agent GCS reporting canary
description: "Configure private GCS reporting for the training agent, verify durable buyer receipts, and qualify the Fly canary before rollout."
"og:title": "AdCP — Private training-agent GCS reporting canary"
---

# Private training-agent GCS reporting canary

This change prepares an opt-in adoption of the published `@adcp/sdk@15.2.0`
on the existing Fly `adcp-docs` application. `TRAINING_REPORTING_GCS_ENABLED`
defaults to `false`. A deployed canary and rollout have **not** been performed.
Local tests use real Docker PostgreSQL and HTTP MCP with modeled Storage
and WorkOS ports. A separate controlled application integration run passed eight
checks against a fresh private GCS bucket with dedicated runtime and buyer
identities, short-lived impersonated tokens, real PostgreSQL and HTTP MCP.
It verified a buyer receipt, exact retry, seller reconstruction, scheduler drain,
and a revoked native-generation 404. Runtime listing/IAM reads and buyer
listing/writes/out-of-prefix reads returned 403. WorkOS and historical source
fixtures remained modeled; this does not qualify the deployed application.

The published archive was downloaded and its SHA-256 matched the handoff:
`60aded5bd8caa22771260f2923153ea2878b9c63f4e2a6d0630c255ebe7a067b`.
The handoff's SDK qualification results do not qualify this application deployment.
The repository's TypeScript response probe captured all 125 cases with SDK
15.2.0 and MCP 1.32.1. Coverage and the existing `list_products` schema finding
were unchanged; only the reviewed TypeScript SDK pin in the regression
baseline was updated. The ordinary conformance report still reports that
finding rather than claiming complete protocol conformance.
The change incorporates main through `247127c1a`. PR #7968's SDK/OAuth changes
are included; reporting migration 620 follows OAuth migrations 618 and 619.

## Source and authority

The new offering, `training-gcs-daily-v1`, publishes provisional daily UTC
analytics snapshots from **already committed** private training ledger revisions.
Create an ordinary private training account and its media buys through the
existing tools. Install an active `analytics-daily-managed` configuration with
an explicit scope of one to ten media buys. Continue publishing that source
configuration through the existing training flow. The GCS worker queries its
saved principal/account/configuration/version and exact closed period; it does
not generate reporting rows. Missing or incomplete source coverage returns
`NOT_READY`. An explicitly committed empty revision is eligible.

The source remains simulated advertising data. PostgreSQL, GCS delivery,
inspection, receipts and recovery are real components. No provider job,
authentication, usage or delivery evidence is fabricated. Source manifests
advertise only the basic evidence level.
The adapter build digest hashes the executing entrypoint's actual bytes (TS in
local tests, emitted JS in deployment), and the identity row mapping hashes its
canonical descriptor. Capture the deployed image and artifact digest in live
evidence; local source bytes do not identify a deployed build.

The legacy teaching definition is version 1.1 and declares a SQL-like metric
expression. The published SDK's real inspector accepts definition 1.0 and a
numeric row field. The separate GCS snapshot definition therefore names
`impressions` with `sum` aggregation, retains the aggregate row schema, and
omits the official-correction policy. It has a separate definition ID and
digest. A private canonicalization document binds that exact schema and the
`period_start, period_end` primary keys, with empty and ordering/encoding golden
vectors. The GCS path requires canonical inspection and a consumer receipt;
it makes no official advertising finality claim.

Migration 620 installs the published production composer's Core, finality
writer fence, Managed Delivery, notification/outbox/activity, object inventory
and installation-authority SQL in `training_reporting_gcs`. Core and Managed
use the **same** pool on the application primary. Host tables freeze source
facts, the destination, principal, bucket, namespace and trusted reader grants.
The SDK's installation UUID survives migration replay and process reconstruction.
Source staging is durable, bounded to 128 executions per account at 4 MiB each,
and retained for 32 days. Admission refuses exhaustion without evicting bytes
within the advertised 31-day retention window.

Do not attach an independently writable database clone to these live objects.
A new installation needs a new authority and fresh dedicated bucket. Retain
the old installation's grants, tombstones and inventory until its cleanup has
finished. Do not clear the reporting schema to repair a failed deployment.

## Database bootstrap prerequisite

**Provision or verify the namespace before running any application migrations,
even when `TRAINING_REPORTING_GCS_ENABLED=false`.** Migration 620 is unconditional;
an absent namespace stops the startup migration runner and app startup. This
prerequisite applies to local development, CI, staging, fresh Fly deployments
and disaster recovery. Disabling the feature does not remove it. Do not skip
or mark the migration applied without creating its tables.

Start the database first, verify that it is the authoritative application
primary, then have a DBA provision the isolated schema owned by the actual
application database role. Only after that prerequisite passes should the
ordinary application credential run migrations or the app start with
`RUN_MIGRATIONS=true`. The runtime needs no new database-wide `CREATE` privilege
or DBA credential. For a fresh staging, Fly or recovery database, use a separate
operator connection for this one-time setup; replace the role placeholder with
the verified application login:

```bash
psql "$REPORTING_DBA_DATABASE_URL" --single-transaction -v ON_ERROR_STOP=1 \
  -v application_principal="<actual application database role>" <<'SQL'
CREATE SCHEMA training_reporting_gcs AUTHORIZATION :"application_principal";
REVOKE ALL ON SCHEMA training_reporting_gcs FROM PUBLIC;
SQL
```

If the schema already exists, inspect its owner and installation authority
instead of recreating it. Verify the application role has `USAGE` and `CREATE`
on that schema. Preserve its installation UUID, grants, inventory and tombstones;
do not attach a writable recovery clone to the existing bucket. A fresh
installation uses fresh authority and a fresh bucket. Repository CI provisions the same scoped schema
outside the application boundary, then applies and replays migrations with
the application role's database-wide `CREATE` permission absent.

### Local bootstrap

For the repository's local Docker database, start PostgreSQL separately before
starting the app. Run the following operator setup for both new and existing
volumes, including after `docker compose down -v`. It creates the namespace
when absent, refuses an unexpected owner, and preserves all existing tables
and installation authority. These commands use only the compose fixture's
`adcp` role and `adcp_registry` database; use the separate DBA procedure above
for staging, production and recovery.

```bash
docker compose up -d --wait postgres
docker compose exec -T postgres psql -U adcp -d adcp_registry \
  --single-transaction -v ON_ERROR_STOP=1 <<'SQL'
DO $bootstrap$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_namespace
    WHERE nspname = 'training_reporting_gcs' AND nspowner <> 'adcp'::regrole
  ) THEN
    RAISE EXCEPTION 'Inspect the existing reporting namespace owner before bootstrap';
  END IF;
  CREATE SCHEMA IF NOT EXISTS training_reporting_gcs AUTHORIZATION adcp;
  REVOKE ALL ON SCHEMA training_reporting_gcs FROM PUBLIC;
END;
$bootstrap$;
SQL
docker compose up --build
```

## Dedicated GCP identity and bucket

Read-only inspection of the current Fly web machine identified
`addie-signer@adcp-production.iam.gserviceaccount.com`, loaded from
`GCP_SA_JSON`, with no GCS reporting flag configured. Only identity fields were
read; credentials were not exported. Its original project `testIamPermissions`
request returned HTTP 403. Subsequent user OAuth allowed project and organization
IAM inspection: neither policy granted that signing identity storage access.
The project initially contained no GCS buckets. The controlled integration
used a separate runtime identity with exactly the four permissions below,
bound only to its fresh bucket. Its buyer had only `storage.objects.get`,
conditioned on the two authoritative saved prefixes and an expiry. Neither
service account had a user-managed key. Retain deployment-specific IAM evidence;
the fixture's impersonation authority is not a Fly runtime credential.
Do not reuse that signing identity or copy user ADC into reporting secrets.

An operator with project provisioning authority must create a **fresh** bucket
in `adcp-production`. The dedicated `training-reporting-runtime` service account
and `trainingReportingRuntime` role remain from controlled qualification, with
no bucket grants, user-managed keys or temporary impersonation bindings.
Reinspect them, then bind the role only to the new deployment bucket. The
controlled fixture bucket and buyer identity were deleted after retaining
revocation evidence. These commands prepare another fresh deployment bucket:

```bash
REPORTING_BUCKET=adcp-training-reporting-UNIQUE-SUFFIX
gcloud iam service-accounts describe \
  training-reporting-runtime@adcp-production.iam.gserviceaccount.com \
  --project=adcp-production
gcloud iam roles describe trainingReportingRuntime --project=adcp-production
# Require exactly: storage.buckets.get, storage.objects.get,
# storage.objects.create, storage.objects.delete.
gcloud storage buckets create "gs://$REPORTING_BUCKET" \
  --project=adcp-production --location=us-east4 \
  --uniform-bucket-level-access --public-access-prevention \
  --soft-delete-duration=0
gcloud storage buckets add-iam-policy-binding "gs://$REPORTING_BUCKET" \
  --member=serviceAccount:training-reporting-runtime@adcp-production.iam.gserviceaccount.com \
  --role=projects/adcp-production/roles/trainingReportingRuntime
```

Verify zero soft-delete retention, no versioning, lifecycle rules, retention
policy/lock, default holds or object-retention settings before any writes.
The SDK checks bucket policy at startup, readiness and provider operations.
Inspect bucket, project and inherited IAM: a bucket binding alone cannot
prove that an identity lacks permissions elsewhere. The runtime role excludes
bucket policy mutation and object listing. Create plus delete permits the
generation replacement used by the revocation fence.
See Google's [bucket creation flags](https://docs.cloud.google.com/sdk/gcloud/reference/storage/buckets/create)
and [Storage permissions](https://docs.cloud.google.com/storage/docs/access-control/iam-permissions).

Use a dedicated workload identity credential configuration where the Fly
deployment has an authenticated external workload issuer. If that integration
is unavailable, an operator may provision a dedicated runtime service-account
credential through the existing Fly secret mechanism, with rotation and only
the scoped role above. This patch accepts an explicit credential file and
never falls back to ADC or `GCP_SA_JSON`.

## Fly configuration

Keep the existing web/worker process groups and release migration command.
Stage the reviewed image with the flag disabled first. A canary environment
with its own application primary and bucket can validate the full deployment
before enabling the existing public application. Do not use a writable clone
of the existing reporting authority for that canary.

All web and worker processes need the same values and dedicated credential
file. Only the worker starts the coordinated scheduler. A Fly `[[files]]`
entry can materialize a dedicated, base64-encoded credential secret; add it
only when that secret is provisioned, to avoid breaking ordinary disabled
deployments. See [Fly's files configuration](https://docs.fly.io/reference/configuration#the-files-section).

```toml
# Add when the dedicated credential secret has been provisioned.
[[files]]
  guest_path = "/run/training-reporting-gcp.json"
  secret_name = "TRAINING_REPORTING_GCS_CREDENTIALS_BASE64"

# In [env], for the reviewed canary deployment:
TRAINING_REPORTING_GCS_ENABLED = "true"
TRAINING_REPORTING_GCS_BUCKET = "<fresh dedicated bucket>"
TRAINING_REPORTING_GCS_NAMESPACE = "training-sales:gcs-canary-v1"
TRAINING_REPORTING_GCS_CREDENTIALS_FILE = "/run/training-reporting-gcp.json"
TRAINING_REPORTING_GCS_CANARY_PRINCIPAL = "workos:<verified private principal>"
TRAINING_REPORTING_GCS_FRESH_BUCKET_ACK = "true"
```

Never change the saved bucket or namespace for an existing installation.
Ensure stable RFC 9421 webhook signing material is available to both process
groups; the existing KMS-backed signer can sign notifications without being
the GCS identity. Readiness checks SQL, notification recovery authority,
installation authority and bucket policy. Enabled initialization failures
refuse startup. Shutdown closes HTTP admission, drains the coordinated
scheduler, then closes reporting and application pools. Shutdown does not
redirect a GCS request to the teaching fixture.

The dedicated pool has four connections per process, a 5-second acquisition
and lock timeout and 30-second statement timeout. Source/provider operations
have a 30-second deadline. The worker polls every 15 seconds with four planned
obligations and two execution iterations per account; notification recovery
is limited to 25 activities and ten webhook deliveries per pass. Recovery is
two hours, status/resource retention is 31 days, and revocation is advertised
within five minutes. Measure these promises under the actual Fly/GCP/IAM
conditions before enabling accounts.

## Authenticated provisioning and saved buyer pins

The private control plane is under `/sales/reporting`, behind the existing
bearer transport authenticator. Only the configured private WorkOS
principal can provision its own durably resolved account. Shared public,
demo and anonymous principals cannot provision. The current canary permits
one account per principal and one immutable destination generation (1).
Revoked generation 1 cannot be reopened through provisioning retries.

`POST /sales/reporting/destinations` accepts exactly:

```json
{"account_id":"<owned account>","source_config_id":"<active daily config>","destination_ref":"<stable destination>"}
```

Persist the authenticated response in a private file. It contains `grant`,
`buyer` (installed time and independently pinned expected contract), and the
SDK delivery capabilities. The exact object prefix comes from the saved
authoritative object-write binding, not a reporting URL. No caller can choose
the bucket, prefix, principal, credential or generation. Partial provisioning
can be retried with identical source facts and destination.

This is an opt-in control-plane bridge to the existing `sync_accounts` source
configuration. Public teaching capabilities remain unchanged. Canary buyers
must use the capabilities returned by provisioning and explicitly select
`gcs:<source_config_id>` when polling; source publication still selects the
original configuration ID. Account-wide teaching and GCS status cannot be
combined into one snapshot.

`GET /sales/reporting/destinations/:accountId/:destination` rechecks saved
ownership and current generation. Responses are `Cache-Control: no-store`.
`DELETE` revokes the authoritative generation before cleanup. Keep the
pre-revocation grant and native generation evidence for the 404 probes.

Create a **different**, keyless buyer reader identity. Give it only
`storage.objects.get`, conditioned on these saved exact prefixes:

```text
resource.name.startsWith('projects/_/buckets/<saved bucket>/objects/<saved object_prefix>')
|| resource.name.startsWith('projects/_/buckets/<saved bucket>/objects/<saved contract_prefix>')
```

Bind the GCP reader identity to the authenticated private buyer principal in
the operator's provisioning record; returned resource URLs cannot authorize
new grants. Inspect inherited roles and prove that the reader cannot write,
list unrelated objects, or read another destination. Use a short-lived IAM
condition for the canary and retain credential-free policy evidence. Reader
credentials stay in the buyer process. Logical generation revocation closes
the app grant immediately; native generation fencing, rather than IAM role
removal alone, must produce the required old-generation 404s.

## Independent buyer, notification and recovery gates

`scripts/training-gcs-buyer.mjs` uses the official SDK MCP client, official
Storage client, private scoped readers and the public buyer reconciler. It
reads the saved provisioning file, independently selects a closed UTC day
after installation, and uses a separate buyer-owned PostgreSQL database for
durable checkpoints and pending status retries. It recomputes exact Core
binding digests, inspects GCS bytes and private contracts, and submits an
earned receipt. The buyer credential file must be a keyless `external_account`
configuration for the dedicated reader identity.

Set `TRAINING_BUYER_TOKEN`, `TRAINING_BUYER_GCS_CREDENTIALS_FILE` and
`TRAINING_BUYER_DATABASE_URL` privately; none are written to evidence. The existing training agent exposes MCP; use
the same buyer state across process restarts. `--init` installs buyer persistence once:

```bash
node scripts/training-gcs-buyer.mjs --init \
  --provisioning .context/canary-grant.json --day <closed UTC day> \
  --evidence .context/buyer-mcp.json
node scripts/training-gcs-buyer.mjs --command replay \
  --provisioning .context/canary-grant.json --evidence .context/buyer-mcp.json
```

The replay command resends the captured exact receipt/status batches. The SDK
may replay the original `recorded` result for an identical idempotency key;
verify one durable receipt rather than requiring an `unchanged` label.
Restart the buyer process and seller worker, repeat authenticated polling,
and confirm unchanged authority UUID, namespace, destination, digests and
receipt evidence. A failed/nondefinitive result leaves evidence for repair;
it is not a canary pass.

Register at most two RFC 9421 endpoints with
`PUT /sales/reporting/notifications/:accountId`. Supply subscriber ID, HTTPS
URL and event types (`reporting.ledger_changed`, `reporting.status_changed`,
`reporting.delivery_ready`); caller-supplied delivery credentials are refused.
The receiver must verify the signed challenge and return its challenge value,
then durably authenticate and deduplicate notification deliveries. Capture an
actual delivery with signature validation. Stop/restart the receiver and the
worker during an outstanding attempt, demonstrate durable retry, then omit
one notification and repair by authenticated polling. The existing signer,
control proof and SDK PostgreSQL outbox are wired; a deployed receiver and
live webhook recovery have not been qualified here.

After authoritative revocation and managed cleanup, run:

```bash
node scripts/training-gcs-buyer.mjs --command revoked-404 \
  --provisioning .context/canary-grant.json --evidence .context/buyer-mcp.json
```

This directly requests each previously captured **native generation** using
the saved reader grant. A 403, a current tombstone, or a synthesized response
does not pass. Retain old-generation 404s and current tombstone/inventory
evidence. Do not delete the bucket or schema to make a revocation test pass.

## Rollout and failure recovery

Before enabling the existing Fly application, retain: the reviewed image/head,
successful repository gates, migration results, bucket/IAM policy inspection,
dedicated runtime and reader identity evidence, actual MCP buyer receipts,
duplicate retries, webhook delivery/polling repair, process restart and
graceful shutdown, and revoked-generation 404s. GCP provisioning access is now
available through temporary user OAuth, and the controlled GCS application
integration passed. Dedicated Fly runtime credentials, a real buyer principal,
webhook/polling recovery and deployment-specific hosting/capacity evidence
remain pending. The merge deployment workflow can change the running application;
do not merge this as an enabled rollout before the evidence exists.

Start with the single private account. Broader account enrollment requires
reviewing the canary limit, trusted consumer roster, per-process PostgreSQL
connection budget and reader-grant provisioning. Monitor pending obligation
and materialization ages, attempt counts, notification/outbox lag, cleanup
age, SQL pool saturation, and safe SDK provider/authentication diagnostics.
Query the reporting schema on the authoritative primary; never log credentials
or turn returned resource URLs into reader scope. Freeze new enrollment on
failure, keep the authority and tombstones, repair IAM/provider availability,
and roll forward with a writer-compatible image. For emergency shutdown,
retain the database/bucket and restart a compatible cleanup worker; disabling
all workers also pauses revocation cleanup and is not proof of its SLA.

Follow the SDK's [managed GCS](https://github.com/adcontextprotocol/adcp-client/blob/main/docs/guides/REPORTING-GCS-MANAGED.md),
[writer fence](https://github.com/adcontextprotocol/adcp-client/blob/main/docs/guides/REPORTING-GCS-FENCE.md),
and [operations](https://github.com/adcontextprotocol/adcp-client/blob/main/docs/guides/REPORTING-OPERATIONS.md)
runbooks when rolling forward. Keep SDK umbrella issue #3027 open; this
application canary is one adoption step in that broader work.

## Local validation

The PostgreSQL integration suite refuses nonlocal hosts and any database name
other than `training_gcs_tests`. It recreates only its dedicated local schema
and legacy ledger/idempotency table fixtures. Never use the shell's application `DATABASE_URL`
for this test.

```bash
docker compose up -d postgres
# Use the published local compose port; create training_gcs_tests as adcp.
TRAINING_GCS_TEST_DATABASE_URL=postgresql://adcp:localdev@127.0.0.1:<port>/training_gcs_tests \
  npx vitest run --config server/vitest.config.ts \
  tests/integration/training-gcs-reporting-postgres.test.ts
npx vitest run --config server/vitest.config.ts \
  tests/unit/training-gcs-reporting-config.test.ts \
  tests/unit/training-gcs-reporting-routes.test.ts \
  tests/unit/training-gcs-reporting-tools.test.ts
```

The integration suite exercises shared PostgreSQL authority, migration replay,
private provisioning/isolation, scoped durable source replay, missing-source
refusal, actual producer/managed execution, official MCP HTTP buyers with
modeled Storage and WorkOS, independently inspected receipts and conflicting retries,
seller reconstruction, modeled generation
revocation, and coordinated scheduler drain. Modeled provider generations
and 404s are explicitly labeled and do not satisfy the live rollout gates.
