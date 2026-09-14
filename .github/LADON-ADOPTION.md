# Ladon findings without bot approval: adoption hold

**Branch protection is not fixed by this PR.** Keep this PR Draft with
no auto-merge until exact-head CI, an independent audit, and actual human
maintainer review. Agent audits and requested reviewers are not human approval.
The existing review-workflow-modification gate remains unchanged: this mixed
workflow/test/doc PR receives only the trusted base workflow's COMMENT if run
while ready; it cannot review or approve its own adoption. Draft runs skip Ladon.

## Full intended inventory

The human-only rollout includes **five** Ladon consumers: actions itself,
adcp, adcp-client, adcp-go and adcp-client-python. There are four separate
external adoption PRs; actions' own workflow adopts the immutable pin and
explicit false as part of human-reviewed #29. No approving consumer is accepted
or excluded by this rollout. A new consumer requires an explicit inventory
update and human review.

The read-only organization audit in #29 (`node scripts/audit-ladon-consumers.cjs`)
reconciles organization code search with all visible active repositories' exact
default-branch workflow blobs. It fails on a sixth consumer, a missing expected
consumer, wrong/floating/local pin, nonliteral or missing false input, incomplete
search/API data or head movement. Run it after external adoption with
`--actions-head EXACT_REVIEWED_ACTIONS_PR_HEAD` to inspect #29's proposed
self-review workflow alongside the four live external consumers before any
publication. This is explicitly a candidate report, not live enforcement.
Without that option it checks all five live default branches and remains failed
until actions' own change lands. Repeat the live audit afterward. Do not weaken
the audit to make rollout CI green. A human administrator must also
confirm full organization visibility; neither code search nor this read-only
report configures protection.

## Immutable dependency contract

| Dependency                                              | Commit                                     |
| ------------------------------------------------------- | ------------------------------------------ |
| Orchestrator / reviewed regression suite                | `d6e930d4a2a01ee0d476fd8347eaf258f85d889c` |
| Nested setup and arbiter (including executable bundles) | `d2422f6b24f6c0b7535c1155e9175d388be44174` |
| Nested reviewer                                         | `a64a17ba369122d6b3401f614a31df7b8607f043` |

The single current Ladon invocation pins the orchestrator and explicitly sets
`auto-approve: 'false'`. Its nested Ladon actions are immutable at the revisions
above. These are the reviewed revisions in
[actions #29](https://github.com/adcontextprotocol/actions/pull/29), even if that
Draft PR later receives documentation-only commits. No floating Ladon tag is
used. Preserve these commits when landing the actions series.

The read-only `Ladon approval policy` CI job checks out the exact consumer head,
parses all tracked workflow/local-action invocation sites, and rejects missing,
enabled, malformed, boolean or expression-valued approval inputs. It verifies
nested runtime bytes against their pins and runs the reviewed upstream tests,
type checks and builds. Upstream tests cover clean COMMENT, findings, failing
critical/high requests for changes, failing human escalations, stale dismissed
approvals, direct stale-reapproval shell execution, bots/authors and zero APPROVE
API calls in disabled mode. It inspects calls before any cleanup, so there is no
transient approving write to race auto-merge in this pinned mode.

The consumer's **configuration tests** reject an omitted input. The revised
review/setup/arbiter manifests default to `'false'`; omission cannot enable
approval. Explicit `'true'` is an opt-in compatibility path, forbidden by this
rollout's inventory policy.
Explicit invalid runtime values fail before posting. The base workflow's human
modification gate protects changes to this invocation; the new unprivileged CI
is a regression check, **not** the trusted human-approval status described below.
Blocking findings and escalations still fail; this adoption does not turn Ladon
into an unconditional successful check.

## Three incidents, two distinct bypasses (2026-09-14 UTC)

1. [adcp-client #2911](https://github.com/adcontextprotocol/adcp-client/pull/2911)
   had only `aao-secretariat[bot]` APPROVED at exact head
   `a6834d67870253674178d099447af36dd6640b11`. Requested `bmilekic` never reviewed.
   REST review `5200764177` was submitted at `17:23:07Z`; author-enabled
   auto-merge completed at `17:23:15Z` as
   `8ba12c2ace85a88533ce1d56efd35badea51a97c`. No package release was recorded.
2. [adcp #7521](https://github.com/adcontextprotocol/adcp/pull/7521)
   had **zero APPROVED reviews**. Its only review, `5200346889`, was
   `aao-secretariat[bot]` COMMENTED at `16:38:41Z` on exact head
   `e680c97e05e69cf3d7b6bf60aed07c42657c420c`, explicitly escalating changes to
   `static/schemas/source/compliance/comply-test-controller-{request,response}.json`
   for human/CODEOWNERS approval with `REVIEW_REQUIRED`. Base was
   `36a86d6c4ae5c42e5e2e783d95bdb97b5cb6f614`. Author `bokelley` nevertheless
   merged it himself at `18:02:02Z` as
   `1467e46117e8d329f4116e548e9290be75d8e3b3`; final `auto_merge` was null.
   This demonstrates author self-merge despite an explicit human escalation;
   disabling bot APPROVE addresses only the first incident's approval path.
   It does not prove which effective bypass permission enabled the second.

3. [adcp-client #2913](https://github.com/adcontextprotocol/adcp-client/pull/2913)
   had only bot approval at exact head
   `bfacfeb66178d161254830faef48f36a5a6a629e`: Secretariat review `5201034616`
   APPROVED at `17:51:07Z`; `bmilekic` remained requested without reviewing.
   After the coordinator disabled auto-merge and put the PR in Draft, author
   `bokelley` re-enabled auto-merge at `17:57:24Z` and it merged at `17:59:28Z`
   as `55829081dae2673f73615af2a4f6f029cddff813` (base
   `8ba12c2ace85a88533ce1d56efd35badea51a97c`). Bot review `5201137108`
   APPROVED the same head at `18:01:40Z`, **after merge**; it cannot be human
   evidence or a cause of that merge. Old approval-capable runs can still write
   approvals, and Draft/auto-off comments are advisory against an author/admin.

Initial inspection found inherited organization ruleset `8519441` and repository
rulesets `15545291` (adcp) / `15545837` (client). Approval-count/CODEOWNERS rules
and stale/last-push rules were visible, with role/admin/integration bypasses.
Visible required checks did not include `code_review` or a separate human gate.
Classic protection returned 403, so this was **not a complete effective audit**.
An escalation comment or an optional failed check does not enforce a merge hold.

## Coordinated dependency order and quarantine

1. Maintain the operational human merge hold. Inventory active bot approvals and
   all older runs (including reruns, queued jobs, other review entrypoints and
   App/machine users). Authorized maintainers must cancel/drain them and dismiss
   obsolete approvals under the hold. COMMENT never revokes an old approval;
   this pin cannot stop an in-flight older action. Do not race cleanup against
   auto-merge. No such cancellation/dismissal is performed by this PR.
2. Obtain exact-head CI and independent audit, then actual human review of
   **all four** separate external consumer PRs. Land all four external immutable pins through the audited
   human procedure. External consumers may land in any order; all four precede actions
   promotion. Do not loosen the workflow-modification gate for testing.
3. Complete the administrator audit/controlled validation below before lifting
   the hold or merging actions #29. Merging actions/main invokes automatic tag
   publication. **Do not merge #29 or move `ladon/review/v1` until all four
   human-reviewed external consumer pins have landed and the effective human gate is
   verified.** Keep consumer SHA pins after promotion.
4. Keep [Version Packages #2912](https://github.com/adcontextprotocol/adcp-client/pull/2912)
   quarantined Draft/auto-off. Its generated head advanced to
   `1be6b25e8083601f8bf08f1b701435181f33215f` on base
   `55829081dae2673f73615af2a4f6f029cddff813` after #2913 merged externally.
   Coordinator evidence reports npm dist-tags still at rc.36 / latest 13.0.4,
   with no new package published. Maintain a **global release/merge hold**
   until all four external consumer pins land and an authorized human configures and
   validates the actually required trusted human-approval gate. This work does
   not undo #2913's merge, authorize a release, or change either PR.

Main snapshots are evidence at a point in time, not moving claims. The consumer
bases were refreshed to adcp `1467e46117e8d329f4116e548e9290be75d8e3b3` and
client `55829081dae2673f73615af2a4f6f029cddff813`. PR bodies record their exact
base/head/tree and CI/audit evidence. Other open PRs, including adcp #7450/#7462,
retain their older-base evidence until individually refreshed; this adoption
makes no claim to have recomputed their merge trees.

## Required administrator action (not executed here)

An explicitly authorized repository/organization administrator must:

1. Export the **effective** main rules from repository Settings → Rules →
   Rulesets, inherited organization rules, classic branch protection, and all
   bypass lists. Record rule IDs, branch patterns, enforcement, expected check
   producer App IDs, CODEOWNERS coverage and current permissions. Determine
   exactly how #7521's author was permitted to merge. Inspect admin/custom-role,
   write/maintain-role, integration, merge-queue and direct-push bypasses.
2. Install a separately reviewed, trusted producer for required status
   `Human review / exact head`. Run trusted base or independent App code only;
   never PR-head code with write credentials. Require its specific producer
   App identity, not just a spoofable context name. Require the policy's Ladon
   blocking result as well, with explicit handling of workflow-modification
   human holds and high-risk exceptions; optional failures do not block merge.
3. The human producer must paginate reviews, resolve the latest effective
   non-dismissed review per person, and count only APPROVED at the **live exact
   head** from currently authorized collaborators/required CODEOWNERS. Exclude
   the PR author, all Apps/bots, and known automation accounts typed as User.
   Check current collaborator permissions, required teams and CODEOWNERS at the
   trusted base; fail closed on unknown identities, missing authority, partial
   data or API failure. Requested reviewers alone never count.
4. Recompute on push/synchronize, ready-for-review, review submission/dismissal,
   base/policy/CODEOWNERS and membership/permission changes; handle merge queues
   explicitly. Serialize per PR, re-read head and review/authority state before
   publishing, reject stale workers, and invalidate success when any input
   changes. Combine with native stale-review dismissal and last-push approval.
   Status webhooks are asynchronous: document and test the dismissal/merge
   race; if atomic enforcement is not established, retain the operational hold
   and use an authorized, trusted merge procedure that revalidates immediately.
5. Make the requirement **non-bypassable by ordinary authors**, including the
   author role implicated by #7521. Remove broad role/App bypasses or constrain
   them to an independently controlled, logged emergency procedure unavailable
   to ordinary authors. Prevent direct-push and alternative merge entrypoints
   from evading the same requirement. Settings changes require explicit human
   authority; neither this PR nor green CI grants that authority.
6. Record controlled validation under both ordinary author and maintainer roles.
   Begin on a non-production branch with matching effective protections and no
   deployment/release hooks; any actual merge attempts need separate explicit
   administrator authorization. Prove rejection for no reviews, bot-only
   approval, COMMENT-only escalation (#7521), requested-but-absent review,
   self/old-head/dismissed approval, lost collaborator/CODEOWNER authority,
   failed/skipped/missing human status, API failure, stale worker, fork,
   workflow-modifying PR, rebase and merge queue. Exercise concurrent push,
   dismissal and auto-merge; an obsolete success must not permit merge. A
   valid current-head authorized **non-author human** approval may satisfy only
   the human gate; unresolved blocking Ladon findings must remain blocking.
7. Verify the actual main branch's effective rules and producer identity after
   the controlled tests. Record settings exports, exact PR/head/status/reviewer
   evidence and permission-denied merge results, including denial of the
   #7521 author scenario. A sandbox-only test is not proof of main enforcement.
   Lift the hold only with a named human administrator's recorded acceptance.

No ruleset, branch setting, tag, merge, deployment or release mutation is part of
these Draft adoption PRs. Do not report branch protection fixed until the
consumer deployments and administrator enforcement/validation are complete.
