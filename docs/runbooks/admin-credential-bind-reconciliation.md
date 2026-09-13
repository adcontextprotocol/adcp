---
description: "Reconcile admin WorkOS credential binding failures, provider compensation, lifecycle quarantine, and uncertain outcomes."
"og:title": "AdCP Admin Credential Binding Reconciliation"
---

# Admin credential binding reconciliation

This is the admin containment and compensation slice of #6827. It does not
close the issue or enable organization authorization enforcement.

`POST /api/admin/users/:userId/linked-emails` creates a fresh WorkOS credential
and binds it without transferring memberships or other app state. An
identity-bearing admin is required. The journal records the exact authenticated
credential and its observed identity; both actor and host bindings are checked
again inside the local transaction. The host must remain primary.

`POST /api/admin/users/:userId/credentials/:credentialId/promote` returns 409,
including requests with `consolidate: true` and orphan-primary repairs, because
its previous consolidation rewrote authority and membership provenance.

## Mutation and replay rules

The dedicated WorkOS client makes one attempt with a ten-second timeout.
WorkOS does not promise general create-user deduplication from an idempotency
header; see the [WorkOS SDK guidance](https://workos.com/docs/sdks/go).

The `admin_credential_bind_operations` journal and its audit event commit before
the provider request. Its normalized-email hash uniquely reserves the address
across hosts while an operation is unresolved or committed. Session advisory
locks serialize concurrent requests for the address and host; uncertain lock
acquisition or release destroys the database connection.

| Status | Meaning and operator action |
| --- | --- |
| `creating` | Intent exists; creation may be in flight or its result may have been lost. Keep replay blocked. |
| `provider_created` | The exact returned WorkOS user ID is recorded; local binding may be incomplete. Keep replay blocked. |
| `committed` | User, binding, authorization epochs and audit committed together. A retry returns success only if actor, host and credential remain live and the original binding and email still match under lifecycle locks. |
| `compensating` | Local rollback was acknowledged and a durable admission quarantine blocks callbacks. Deletion of the exact newly created WorkOS user may be in flight. Keep replay blocked. |
| `compensated` | Provider deletion returned success after a confirmed local rollback, and its terminal marker and audit committed under the lifecycle lock. A fresh attempt with a new provider ID is permitted. |
| `provider_rejected` | A non-retryable provider rejection was received without SDK retries. A fresh attempt is permitted. |
| `reconciliation_required` | Provider, commit, compensation or lock outcome is uncertain. Keep replay blocked until adjudicated. |

A local write failure before COMMIT, followed by an acknowledged ROLLBACK,
permits compensation. Any COMMIT exception requires reconciliation: deleting
the credential could destroy a binding that actually committed. A local row
that appeared independently, including through a webhook, also requires
reconciliation instead of deleting potentially adopted state.

The local bind and committed replay use #7459's seed-6827 credential lifecycle
locks on the same transaction client, followed by binding and identity row
locks. A deletion or quarantine marker blocks all local binding success writes.
Unknown lock/query/cardinality results require reconciliation. The exact actor
identity and active host primary are rechecked while these locks are held.

Compensation first rechecks that the returned provider ID has no local user,
binding or terminal marker under that same fence. It commits
`identity_credential_admin_compensation_quarantined` together with the
`compensating` journal transition and checked audit cardinality. This admission
quarantine explicitly records `provider_delete_confirmed: false`; it does not
claim that WorkOS deleted the user. An unconfirmed quarantine COMMIT prevents
the upstream delete entirely.

A second transaction reacquires the lifecycle lock and requires exactly that
operation's quarantine, matching the provider ID and exact admin credential
and identity, without other markers or local artifacts. It holds the lock
through the provider response and local COMMIT. Only a confirmed provider delete
records the separate `identity_credential_admin_compensation_deleted` marker
with `provider_delete_confirmed: true`. This evidence is distinct from a signed
provider-deletion event. Both lifecycle actions block delayed creation callbacks.
The durable quarantine covers the gap between transactions and survives failed
or ambiguous provider deletion and subsequent marker/audit/COMMIT failures.
Those outcomes remain `reconciliation_required`, with no invented confirmed
deletion claim. `confirmed_delete_evidence_failed` means the provider
acknowledged deletion but its local deletion marker/audit could not commit;
`compensation_commit_ambiguous` means that commit's acknowledgment is uncertain.
Neither result claims successful compensation. A later signed deletion still
records its own provider source and follows #7459's normal replay behavior.

A provider timeout, transport failure, retryable status or failed compensation
never triggers an immediate GET to infer success or rollback. Delayed completion
can invalidate that read. There is no automatic stale-operation expiry. If a
later journal update fails, the previously committed intent remains blocking.

## Adjudication

Use the response's `operation_id` to inspect the journal and audit trail:

```sql
SELECT id, host_user_id, host_identity_id, actor_user_id, actor_identity_id,
       provider_user_id, status, failure_code, created_at, updated_at
FROM admin_credential_bind_operations
WHERE id = :operation_id;

SELECT created_at, workos_user_id, details
FROM registry_audit_log
WHERE action IN ('admin_credential_bind', 'identity_credential_admin_compensation_deleted',
                 'identity_credential_admin_compensation_quarantined')
  AND resource_id = :operation_id
ORDER BY created_at;
```

Keep provider bodies, passwords, tokens and email addresses out of logs and
incident comments. The journal stores only identifiers, an email hash, fixed
status/failure codes and timestamps. It has no foreign keys so later deletion
cannot erase the evidence.

Engineering must establish the final outcome of the original request through
provider request/event history and, where necessary, WorkOS support. A single
current GET, a 404, or elapsed time is insufficient. Match the recorded user ID
and original operation; never delete an account found merely by email.

Inspect the local user, identity binding, epochs and audit in a transaction.
Determine whether a webhook or another flow adopted the created account and
whether it now has independent authority. Preserve those memberships and their
provenance. Repair only the reviewed operation, with an individually attributed
audit event recording the evidence and final disposition in the same transaction
as the journal transition. Mark `committed` only after confirming the expected
binding; release the email reservation as `compensated` only after establishing
that the original creation/deletion request has completed, the created account
is absent, and no local binding remains. Leave unresolved evidence blocking.
For a quarantined credential, retain its quarantine and record confirmed
deletion evidence under the shared credential lifecycle lock before committing
`compensated`. A quarantine alone is never proof of provider deletion.
There is intentionally no public retry-unblock or reconciliation endpoint.

## Route inventory and scope

The existing-credential `POST /api/admin/users/:userId/credentials` remains
contained by #7459 before its legacy WorkOS GET and generic merge handler.
The following admin provider-write routes were traced and do not subsequently
bind or promote a person identity:

- `POST /api/admin/organizations/:orgId/add-users`
- `POST /api/admin/organizations/audit-admins` with `fix=true` (organization role promotion)
- `POST /api/admin/accounts/:id/migrate-members`
- `PUT /api/admin/accounts/:orgId/members/:userId/role`
- `POST /api/admin/domain-users/backfill-members`

No membership mutation was added to fresh credential binding. Member primary
email mutation/reconciliation, automatic alias detection, generic merge
containment and detach integrity remain separate work.

## Merge order with containment #7459

This PR is stacked on the exact [#7459](https://github.com/adcontextprotocol/adcp/pull/7459)
head `9a7cd5362787a0badbfccd0f1cb1dd002654c22f`. Land #7459 first, then retarget
and rebase this PR onto main. Its database, member, automatic alias,
existing-credential and promotion guards remain intact. Fresh binding does not
call or add an exception to `mergeUsers` or the consolidation policy.

The only predecessor is corrected #7459. The admin saga has no API or schema
dependency on #7460 or migration 594; it uses existing identity, epoch and audit
tables plus its independent journal 593. Keep the corrected predecessor's
post-deletion missing-primary signal intact when rebasing.

The shared `server/src/routes/admin/users.ts` hunk is resolved as follows:

- Keep both the `refuseIdentityConsolidation` and `createAndBindAdminCredential`
  imports.
- Keep `refuseIdentityConsolidation` on `POST /:userId/credentials`.
- Keep `POST /:userId/credentials/:credentialId/promote` as an unconditional
  refusal using that middleware, with no legacy mutation body or orphan repair.
- Replace only `POST /:userId/linked-emails`'s blanket refusal and old merge body
  with this PR's fresh-credential handler and durable saga. Requests to
  consolidate or promote are still refused before any provider operation.

The overlapping tests retain the fresh-bind/fault tests and #7459's
existing-credential and broader promotion containment assertions. Promotion
fixtures bind directly in SQL. Only fresh `/linked-emails` is removed from the
blanket-refusal matrix; new route tests cover identity-bearing authentication,
destructive intent rejection, exact actor attribution and provider/local failure
boundaries. Both PRs' focused suites and typecheck must pass after rebasing.

Migration 593 was assigned after a read-only live ledger audit on 2026-09-13:
the highest applied version was 587; versions 588–592 and 593 were absent.
Main subsequently added unrelated migration 589; this change adds or modifies
none of 588–592. Migration 592 remains owned by member compensation
[#7463](https://github.com/adcontextprotocol/adcp/pull/7463). The local/origin-main
union and open-PR migration audit have no collision for 593. Recheck migration
numbering before merging parallel security PRs. If #7463 lands first, retain
both independent WorkOS client factories and both timeout tests when resolving
their shared insertion points; the admin journal does not depend on 592.
