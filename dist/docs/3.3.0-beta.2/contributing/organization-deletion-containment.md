---
description: Why direct organization deletion is unavailable, which routes are contained, and the durable lifecycle requirements for re-enabling deletion.
"og:title": AdCP organization deletion containment
---

# Organization deletion containment (#6827)

Self-service `DELETE /api/organizations/:orgId` and administrative force-delete
`DELETE /api/admin/accounts/:orgId` are temporarily unavailable, and so is
organization merge, which deleted an organization as its final step. These are
containment slices, not closure of #6827 or a safe organization deletion service.

Requests reaching either delete handler receive HTTP **503** with the stable body
below. Organization merge is contained too, with its own code and behind
administrative authentication — see the merge section further down.

```json
{
  "error": "organization_deletion_unavailable",
  "message": "Organization deletion is temporarily unavailable."
}
```

The response is unconditional and contains no organization-specific information.
It runs before route authentication, which can hydrate local identity and cache
state, and before authorization, subscription reads, WorkOS/Stripe calls, local
writes, cascades, deletion audit records, cache invalidation or notifications.
The existing server-only observer exclusion prevents post-response canonical or
exact-credential WorkOS reads, including for an already populated principal.
There is no bypass for an exact owner/admin, platform administrator, static admin
key, tenant API key, development session, credential grant, matching email/domain,
subscription status, confirmation text, `force` parameter, or linked canonical
sibling. Unknown IDs receive the same response. Repeated calls perform no work;
there is no operation ID or retry schedule because no operation was accepted.

Everything in this section describes the two DELETE routes. The contained merge
route runs *after* `requireGlobalAdmin`, so none of the anonymous-reachability
properties below apply to it.

Global parsing, CSRF protection and ordinary request metrics remain in place.
A parser or CSRF rejection may precede the 503, and the global JSON body parser
still accepts its usual limit for these paths before the route is matched — both
were already reachable unauthenticated on the identical path. Because 503 is a
server-error status, `requestMetrics` records every contained request as a failed
`/api` request, so an unauthenticated caller can raise the 5xx rate for these two
paths at no cost. No page results: the only Slack alerting on this path is the
10-second slow-response gate and this handler is constant-time. An external
error-budget monitor keyed on 5xx should exclude these two routes. Successful authentication is not
needed to learn that this operation is unavailable; no data or authority is
returned. Organization reads and unrelated membership/domain routes retain their
existing behavior and authorization. This change does not establish their
broader security acceptance or restore any previously contained operation.

## Two deliberate divergences from neighbouring handlers

**Returning before `requireAuth`/`requireAdmin`.** The repository's precedent for
a switched-off admin endpoint keeps both guards and returns 410 — see the removed
payment-link and invoice routes in `server/src/routes/admin/prospects.ts`. Those
are *permanently* removed endpoints where running authentication first costs
nothing. This containment diverges because `requireAuth` itself performs provider
and database work: WorkOS API-key validation, sealed-session loading and platform
ban lookups. Those are exactly the side effects this slice must not perform, so
the response has to precede them. The contained handler is strictly cheaper than
the middleware it replaced, and the mounted tests assert that neither API-key
validation nor session loading fires.

**A machine-stable snake_case error code.** Neighbouring 503s in these two files
use a human sentence in `error`. `organization_deletion_unavailable` is a stable
identifier on purpose, so a caller can branch on containment without string
matching, and it is consistent with the dozens of other snake_case error codes
already used across `server/src/routes/`. The human-readable text lives in
`message`.

## Why deletion remains unavailable

The parent implementation used canonical `req.user.id` for the self-service
owner lookup. Linked credential A could therefore authorize using sibling B's
owner membership. Administrative deletion depended on the existing admin policy,
which also includes canonical identity and static administration. Exact identity
checks alone would not repair the deletion lifecycle.

Both handlers read the organization and payment history, obtained subscription
information (potentially reading Stripe), checked confirmation, and then:

1. Inserted `organization_deleted` into the local audit table.
2. Attempted WorkOS organization deletion (admin skipped it if WorkOS was absent).
3. Swallowed a WorkOS error and continued with local organization deletion and
   its foreign-key effects.
4. Reported success if the local delete completed.

Those steps were not one transaction. Provider failure could leave a live
provider organization with local state deleted. A timeout could complete late;
a local failure after provider success could leave the opposite split state.
The early audit asserted deletion before either outcome was known. Subscription
creation could race the preliminary billing reads. The containment removes this
sequence; it does not attempt to recreate an organization as compensation.

The parent behavior above was demonstrated during investigation by running the
parent commit's handlers against a disposable local PostgreSQL database with a
WorkOS double. That demonstration is deliberately **not** committed: its
assertions require the deleting handlers, so it cannot live in this tree and
cannot be re-run from it. Treat the list below as investigation findings, not as
a reproducible gate. The last item is the one a reader can verify statically from
the schema. What the demonstration established about the parent tree:

- A linked credential with no membership of its own completed a self-service
  deletion using its canonical sibling's owner membership. WorkOS deletion was
  called, an audit row was written, and the organization row was removed.
- A WorkOS rejection was swallowed: the local organization row was still
  deleted and the caller still received `success: true`.
- The `organization_deleted` audit row survived that provider failure, so a
  durable record claimed a deletion that had only half happened.
- A platform administrator completed the same sequence through the
  administrative entry point.
- Both entry points returned the organization name in a pre-deletion
  confirmation error before *exact-credential* authority had been established.
  Authority as such was checked: self-service required an `owner` role and the
  administrative route required `requireAuth` plus `requireAdmin`. The defect is
  that self-service authority was borrowable from a canonical sibling, not that
  it was absent.
- Local `organization_memberships` rows were not removed with the organization,
  leaving dangling membership state for an organization that no longer existed.
  This one is verifiable from the schema: `organization_memberships`
  (`server/src/db/migrations/055_organization_memberships.sql`) declares no
  foreign key to `organizations` or `users`, and no later migration adds one.
  Any future lifecycle design must inventory this edge rather than assume the
  foreign-key graph cleans it up.

## Organization merge: contained by the follow-up

Organization merge was the remaining organization-deletion writer. It is now
contained too, on the same terms and with the same stable shape.

Merge deleted the secondary organization: `mergeOrganizations`
(`server/src/db/org-merge-db.ts`) removed the local organization row inside its
transaction, committed, and only then attempted
`workos.organizations.deleteOrganization`, downgrading a provider failure to a
warning while still reporting success. The Addie path attempted the provider
delete twice — once inside `mergeOrganizations` and again at step 4 of the tool
handler — and interleaved WorkOS membership creation in the primary organization
between the local commit and that second attempt, so its unknown-outcome surface
was strictly larger than the HTTP route's.

Both entry points now refuse before any merge-specific effect:

- `POST /api/admin/cleanup/merge` (`server/src/routes/admin/cleanup.ts`) returns
  HTTP **503** with the stable body below. Administrative gating is deliberately
  **unchanged** — `requireGlobalAdmin` still authenticates and authorizes, unlike
  the contained deletion routes, because nothing here needs to run before
  authentication. The refusal precedes body validation and every merge-specific
  effect.
- The Addie `merge_organizations` tool refuses execution before it reads provider
  memberships, and no longer acquires a WorkOS client at all on that path — the
  client is now constructed inside the read-only preview branch rather than at
  handler entry. The refusal names the stable code, points at preview, and tells
  the model not to improvise a manual database or WorkOS workaround.

```json
{
  "error": "organization_merge_unavailable",
  "message": "Organization merge is temporarily unavailable."
}
```

`mergeOrganizations` itself refuses at the shared service boundary, throwing
`OrganizationMergeUnavailableError` with the same stable code before `getPool()`,
before `pool.connect()` and before `BEGIN`. That is defense in depth: an
overlooked caller, a new caller, or a script that bypasses both entry points
still cannot execute the sequence. The previous implementation was removed rather
than left unreachable behind the guard, because that sequence *is* the hazard —
re-enabling merge has to be a new reviewed implementation meeting the acceptance
requirements below, not the deletion of a guard.

After this follow-up there are **no production call sites of
`workos.organizations.deleteOrganization` left in `server/src`**, so no server
route, tool or service calls the provider's organization-delete operation. The
claim is about SDK call sites; it is not a general statement about every request
this server can construct.

### Operator bypasses closed alongside the route and tool

A containment that only covers routes and services is one an operator can walk
around. Two checked-in surfaces handed them the prohibited operation:

- `scripts/incidents/2026-05-cleanup-duplicate-prospect-stubs.ts` deleted
  duplicate organization rows with direct SQL, and its own header reasoned from
  the absence of an admin delete endpoint that a script was the sanctioned
  route. Its destructive path is removed: it no longer imports a database
  client, issues no writes, and `--execute` hard-refuses before any other
  statement runs. The read-only analysis and report are preserved.
- The `unique-org-per-email-domain` invariant emitted a ready-to-paste raw SQL
  delete with the organization ID already filled in, and pointed at a merge
  endpoint that does not exist. Its `remediation_hint` now routes to read-only
  `preview-merge` inspection plus escalation, and names both containment codes.

`server/tests/unit/organization-delete-statement-guard.test.ts` is the static
guard for this: it scans the JavaScript, TypeScript and SQL files under
`server/src`, `server/scripts` and `scripts` for a raw organization delete and
fails on anything outside a small allowlist that records
why each remaining occurrence is not operator-reachable. Re-introducing a bypass
now requires a deliberate, reviewed edit to that allowlist.

### Remaining honest limitations

- **Merge preview stays available and is genuinely read-only.**
  `previewMerge` and `GET /api/admin/cleanup/preview-merge` issue only SELECT and
  COUNT statements. Preview still projects what a merge *would* move, including
  that the secondary organization would be deleted from WorkOS. The tool's
  WorkOS section uses conditional wording; the existing Stripe and data-movement
  warnings are unchanged. The tool output states that execution will refuse.
- **Three code paths still contain a raw organization delete, none of them a
  deletion service** — all three are recorded in the static guard's allowlist.
  `OrganizationDatabase.deleteOrganization`
  (`server/src/db/organization-db.ts`) has no callers and predates this work.
  Prospect creation (`server/src/services/prospect.ts`) removes the row it
  inserted moments earlier in the same call when the domain link conflicts; it
  never removes a pre-existing organization, but it does leave the WorkOS
  organization it had just created behind. That orphan is a pre-existing
  creation-rollback gap, not an organization-deletion path, and is out of scope.
  `server/scripts/setup-sandbox.ts` seeds and tears down a local sandbox; it is
  bounded to `org_aao_sandbox_*` IDs and refuses to run unless
  `STRIPE_SECRET_KEY` is `sk_test_*`, so it never touches production data. It is
  documented and allowlisted rather than changed.
- **The `merge_organizations` tool's declared description and usage hints are
  unchanged.** They still read "Destructive, cannot be undone" and "Preview
  first, then execute with `preview=false`", which is now misleading. Changing
  them is a one-line edit, but `scripts/addie-tool-surface-budget.json` pins a
  reviewed profile-contract hash over every declared tool profile — it hashes
  the whole profile set, including each profile's wire-schema digest, so a
  one-word description edit invalidates it — and re-blessing that hash is its own
  review decision rather than something to fold into a containment commit. The
  runtime refusal is the authoritative guard in the meantime: an execution
  attempt refuses without effect. Follow-up: update both strings, regenerate with
  `npm run build:addie-tools`, and re-bless the contract hash under its own
  review.
- **Admin UI copy still offers merge.** The merge controls in
  `admin-data-cleanup.html`, `admin-domain-health.html` and
  `admin-account-detail.html` surface the unavailable message correctly (each
  throws on a non-OK response and renders `message`), but the surrounding copy
  still promises a merge. Same known follow-up as the deletion modal below.
- **Not in scope here:** member merge and member migration, domain reassignment,
  and every read-only inspection surface. User and identity merge
  (`server/src/db/user-merge-db.ts`) is separately contained under
  `identity_mutation_disabled`. None of them deletes an organization.

## Operator handling while deletion is unavailable

There is no operator bypass, break-glass credential or hidden flag: the response
is unconditional. A member's legitimate workspace-deletion request — including a
data-erasure request with a compliance deadline — is therefore queued until
deletion is re-enabled, and must be escalated to the engineering owner of #6827
rather than worked around. Direct `psql` deletion and organization merge are both
unsafe substitutes: they reproduce exactly the split provider/local state and the
dangling membership rows described above.

The administrative UI is unchanged by this slice. The danger-zone modal in
`server/public/admin-account-detail.html` still offers a Delete workspace button
and still says workspaces with payment history or an active subscription cannot
be deleted, which is now misleading — no workspace can be deleted. The button
degrades correctly (the operator sees the unavailable message after confirming),
but the copy and the disabled state are a known follow-up.

## Acceptance requirements before enabling deletion

A separately reviewed design and implementation must satisfy every row below on
both entry points and all other participating writers. A role check, feature
flag, migration alone, best-effort rollback, or an in-memory lock is insufficient.

| Boundary / failure | Required durable behavior and acceptance evidence |
| --- | --- |
| Exact authority and target | Bind the authenticated credential, explicit organization, permitted action, membership/grant policy, provider organization ID and authorization epoch to the operation. Reject conflicting/malformed selectors and canonical sibling substitution. Recheck authority at defined irreversible boundaries. Any future admin authority policy requires explicit review; existing static/platform status is not an exception to this containment. |
| Durable operation journal | Persist a unique operation ID, caller/idempotency binding, exact actor and target, immutable preconditions and provenance, provider request correlation, state/version, attempts and known/unknown outcomes before any external mutation. Journal/tombstone retention must survive organization deletion, process death and database recovery. Enumerate every allowed transition and who can perform it. |
| Prepare failure | Journal/precondition/audit-intent failure causes zero provider or destructive local work. Prove connection errors, transaction rollback, epoch changes and billing conflicts. No success or accepted claim without the corresponding durable record. |
| Provider rejection or absence | Classify a definite rejection separately from an unknown outcome. Preserve local organization, memberships, grants and provenance. A missing provider client must never authorize local-only deletion. Record an honest durable outcome and permitted recovery action. |
| Timeout, disconnect and late completion | Persist an unknown/reconciliation-required state across timeout, process crash and restart. Correlate late provider completion, webhook and polling evidence to the same exact operation. Prove completion before/after retry, duplicate and out-of-order events, and no second delete or premature success. A transport timeout is not proof of provider rollback. |
| Local failure after provider success | Preserve the provider outcome durably and expose reconciliation-required status. Inject failure at every local write/commit boundary. Specify exact forward reconciliation or a provider-supported compensation that restores the same IDs, memberships, roles, seats, grants, provenance and dependent resources. If exact restoration is impossible, document that limit and require a safe recovery workflow; never invent replacement identities or silently recreate approximate state. |
| Mandatory audit | Commit truthful intent/outcome records with the corresponding journal/local state transition; audit must survive cascades and identify the exact credential, target and operation. Audit failure blocks success. Prove failures before provider dispatch and after provider completion, without falsely claiming deletion or losing the provider outcome. |
| Replay and recovery | Same key plus same actor/target/payload returns the same durable operation/outcome; conflicting reuse fails. Prove retries after every crash boundary, concurrent duplicate requests, worker lease expiry and restarts. Neither replay nor a stale session may create new authority or repeat an irreversible provider effect. |
| Concurrent subscription creation | Coordinate deletion with checkout, invoice, admin, webhook, sync and subscription writers using a shared durable fence/version protocol. Prove both orderings: subscription wins and deletion refuses without provider effects; deletion reserves the organization and subsequent subscription creation cannot attach or complete unnoticed. Include an in-flight remote subscription that completes after local checks. Locking only the deletion route is insufficient. |
| Concurrent membership/identity changes | Coordinate with membership, grants, owner changes, link/unlink, epoch and ban writers. Preserve historical provenance and reject stale authority without borrowing a sibling. Document unavoidable provider compare-and-swap limits and reconcile them honestly. |
| Local dependent state, cache and notifications | Inventory every cascade/set-null/restrict edge and retained audit/journal record. Make local transitions atomic and bind cache invalidation/notifications to committed outcomes with durable delivery/deduplication. Prove no premature success notifications, missed invalidation or cross-organization effects. |
| Independent qualification | Mounted cookie/JWT/API-key, selector, linked A/B and exact role tests; real disposable PostgreSQL failures/races; provider timeout/late completion tests; restart/replay tests; mandatory audit tests; independent review bound to the exact candidate tree; required repository checks. Controlled doubles alone do not prove live provider semantics. |

No lifecycle journal, migration, deletion worker, compensation or reconciliation
implementation is introduced by this containment, and none is introduced by the
merge follow-up. Historic authority repair and other #6827 surfaces remain
separate work. Enabling organization deletion — whether directly or through
merge — requires a new reviewed change after the complete lifecycle contract
above is accepted.
