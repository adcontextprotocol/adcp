# Addie reliability audit follow-up

This change starts at `0f4512093` on main, after #7649. No production queries,
writes, or synthetic evaluations were used to implement or validate it.

## Existing fixes

- #7641 added exact AdCP recovery keyed by operation, literal endpoint, and
  idempotency key. A corrected call with the same identity already recovers;
  a different operation or key must not be reported as that operation succeeding.
  The audit did not include request tuples, so it does not establish why the
  corrected production call failed to match.
- #7623 reconciles durable certification completion outcomes. It does not stop
  later model prose from claiming completion after a rejected attempt.
- #7649 provides durable evaluation ownership, fenced publication, and observer
  receipts. Owned admissions and coalesced observations previously lacked
  distinct lifecycle logs.
- #7650, which landed after #7649, repairs secure organization creation. It does
  not address Addie's unsupported escalation promises to anonymous users.

## Response truthfulness

The common terminal response pipeline now checks certification outcomes and
support promises before streaming or non-streaming delivery. Teaching history
identifies context only; neither user assertions nor prior assistant statements
are proof of completion. Current successful certification tool receipts or a
current `get_learner_progress` read provide authoritative evidence. The parser
accepts anchored application-owned receipt lines, not arbitrary retrieved text.
Capstone module receipts are emitted only after the module write/reconciliation
succeeds, independently of the passed attempt.

Recognized completion, mastery, and credential claims are rendered from exact
recorded outcomes or replaced with a brief unconfirmed-state explanation. Other
teaching sentences remain available. Credential award and external issuance are
separate claims. A later exchange alone never makes a rejected completion valid.
A historical completion can be confirmed by reading persisted progress again.

This is a deterministic delivery backstop for the covered English outcome
phrasing, not a semantic proof for every paraphrase or language. Expanding the
phrase set should include both false-claim and teaching-flow regressions. Tool
receipt format changes must update these tests and the parser together.

Support claims require an `escalate_to_admin` receipt containing the persisted
request ID. Notification claims additionally require successful notification.
Ancillary thread-flag or notification failures preserve the saved request
receipt. Anonymous sessions cannot create escalation rows, even if they supply
contact details. Guest registration complaints receive the public
`support@agenticadvertising.org` route without soliciting unusable contact data.

## Telemetry and evaluation observations

See [Gemini direct](./addie-gemini-direct.md) for exact, contained, unresolved,
and historically unclassified error definitions. Containment records successful
same-agent continuation after a validation rejection; it is not proof of task
fulfillment, original-operation success, or delivery.

The content-free `agent_quality_evaluation` lifecycle event records admission
(`owned` or `coalesced`, including expired-lease recovery), committed canonical
or audit-only publication, and completion/failure/lease-loss/unconfirmed outcomes.
No URLs, prompts, contact details, credential identities, or lease tokens are
added to these events. Coalescing remains unproven organically until genuine
production overlap occurs; that observation does not justify synthetic traffic.

## Deferred isolated outliers

The shadow warning is a best-effort stale-recovery catch in
`jobs/shadow-evaluator.ts`. Cleanup is retried at subsequent scheduled
invocations. Heartbeat expiry defaults to 20 minutes and is clamped to 15–60
minutes, beyond the ten-minute provider timeout. Terminal writes and subsequent
paid dispatches check ownership. Code and tests do not establish a stale worker
publication defect; changing leases based on one warning would be speculative.

The persistence duration surrounds `threadService.addMessage`; it does not
measure provider time or browser receipt. Per-thread lock and statement timeouts
are bounded at five and ten seconds, with five-second pool acquisition. The
assistant insert and turn finalization share a transaction, and later route
errors preserve an already-completed turn. Without the outlier's trace, timing,
and contention evidence, there is no scoped defect to repair here.

## Deployment and rollback

Migration 607 adds one nullable containment count and consistency constraint.
Apply migrations before the new application version (normal startup ordering).
Historical rows remain unclassified; there is no speculative backfill. Rollback
can restore the prior application while retaining the additive column. Do not
drop it during an application rollback. Old writers leave new containment
values null. Response enforcement and lifecycle logging need no other schema
change, tool-surface expansion, model-provider change, or protocol changeset.
