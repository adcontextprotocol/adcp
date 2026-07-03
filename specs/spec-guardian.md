# Spec Guardian: Addie as the Working Group's Secretariat

**Status:** Approved by Brian 2026-07-03 — Stage 1 in progress
**Date:** 2026-07-03
**Author:** Claude (research: Argus system map, Addie architecture map, governance/release process map)

## Problem

AdCP review load has outgrown its decision-making structure. As of today:

- 3.2.0 milestone: **102 open issues**, due 2026-08-31
- Spec Backlog: 58 open issues; 391 open issues repo-wide; 19 open PRs
- Every non-trivial decision routes to one person. The triage routine's escalation
  outcome is literally `@bokelley, your call: X or Y`.

The current reviewer (Argus) "pretends to be Brian" — its prompt says *"review pull
requests in the voice of Brian O'Kelley... apply his standing engineering bar."*
That worked as a bootstrap, but it has structural ceilings:

1. **A person-clone is not a working group.** One synthetic taste, no diversity of
   perspective, and no legitimacy independent of the person being imitated.
2. **Its knowledge is frozen prose, not accumulated precedent.** Argus is stateless.
   Every review re-derives judgment from a 231-line prompt. Past rulings (the
   `governance_context` echo rejection on #5719, the feed_format ownership call, the
   error-code dual-surface convention) live in Brian's head and scattered PR threads.
3. **It can't ask anyone anything.** When a review needs facts ("does any seller
   implement this today?"), there is no mechanism to route the question to the person
   who knows.
4. **It doesn't know about time.** No release train awareness, no milestone hygiene,
   no "this decision is blocking six other 3.2 issues."

## Diagnosis: three brains, one shared job

The pieces of a synthetic working group already exist — as three disconnected systems:

| System | What it has | What it lacks |
|---|---|---|
| **Argus** (`.github/ai-review/`, `ai-review.yml`) | PR-time review, MUST FIX gates, expert delegation via `Task`, sensitive-path gate, posts as `aao-release-bot` counting toward branch protection | Memory, people access, issue/milestone awareness |
| **Triage routine** (`.agents/routines/triage-prompt.md`, 61KB) | Five outcomes (Clarify/Flag/Ready/Execute/Defer), 2–3 expert consults from `.agents/roles/` (28 roles), webhook-miss recovery | Decision-class routing (everything Flag-class → Brian), memory, follow-through on Clarify |
| **Addie** (`server/src/addie/`) | The only system that knows *people*: member context, WG membership, journey stages, engagement planner with cooldowns, 40+ scheduled jobs, multi-day processes, digest infrastructure | GitHub write access beyond issue creation (no comment/label/assign/review tools), no role in spec review |

Meanwhile the **human governance layer already defines exactly the decision structure
the machines should be using** — the WG charter
(`docs/governance/working-group-charter.mdx`) specifies decision classes with quorum
and thresholds:

| Class | Examples | Quorum | Threshold |
|---|---|---|---|
| Editorial | typos, non-semantic rewording | 3 voting | >50% |
| Normative | optional fields, new tasks, new enum values | 5 voting, ≥2 orgs | ⅔ |
| Breaking | remove/rename, optional→required, semantic changes | 7 voting, ≥3 orgs | ¾ |

...but the automation ignores it. Triage has one escalation path (Brian), not three.
The charter also promises minutes (`governance/minutes/` — empty) and implies a
decision record that doesn't exist.

**The fix is not a better Brian-clone. It is: give the machinery a constitution, a
panel, a memory, and a secretary — and route decisions by class instead of by person.**

## Design principles

1. **Constitution over persona.** Authority derives from documents the human WG can
   ratify and amend, not from imitating a maintainer. Brian's taste gets captured as
   explicit, PR-reviewable principles — that's how he "trains" it from now on.
2. **Secretariat, not senate.** Publicly and legally, the synthetic system is *staff*
   for the human WG: it prepares, analyzes, recommends, records, and chases. Humans
   hold votes on Normative and Breaking changes. (This is also the correct antitrust
   posture for a standards body — members make standards decisions; staff does the
   work.) Brian gets his time back because staff work was ~95% of his job.
3. **One brain, three surfaces.** Shared knowledge lives in versioned repo files that
   all three systems read. Execution stays where it is: Argus in CI (its
   `pull_request_target` + prompt-from-base-SHA security model and branch-protection
   integration are load-bearing — don't move it into the Addie server), triage in the
   routine, process/people work in Addie. This answers "should the logic be in Addie
   daily AND in Addie looking at tickets": the *logic* is shared files; the *surfaces*
   stay specialized.
4. **Memory is the moat.** Every ruling becomes a decision record. Consistency comes
   from citing precedent, not from re-prompting vibes.
5. **Graduated autonomy, measured.** Autonomy expands per decision class only when the
   shadow overturn rate earns it. Trust-but-verify stays (Argus has missed bugs;
   blocking findings get adversarial verification before posting).

## Architecture

### 1. The constitution — `.agents/wg/constitution.md`

Extract the operating knowledge currently smeared across Argus's prompt, the triage
prompt, and the playbook into one canonical document:

- **Spec invariants** (wire compatibility rules, schema conventions, patch-eligibility
  tests — much of this already exists in `playbook.md` §Versioning)
- **Design principles** (MCP-based, async, human-in-the-loop optional, platform
  agnostic, AI-optimized — plus the unwritten ones: fail-closed beats fail-open,
  additive over breaking, don't enum the corpus, no fallbacks)
- **Decision classes**, mapped 1:1 to the WG charter's Editorial/Normative/Breaking
- **Escalation triggers** — the explicit, short list of what still goes to Brian

The constitution is sensitive-path gated (`.agents/*` already is), so amendments
require human review by construction. Argus's persona section ("in the voice of Brian
O'Kelley") is replaced by "apply the constitution; write as the WG's review counsel."

### 2. The panel — `.agents/wg/seats.md`

The 28 role files in `.agents/roles/` are already the seats; formalize them as a
standing panel with defined composition per surface:

- **Chair** (synthesizer — writes the decision memo, records dissents)
- **Seats**: protocol (`ad-tech-protocol-expert`), buy-side + sell-side product
  (`adtech-product-expert`), security (`security-reviewer`), SDK/DX (`dx-expert`,
  `javascript-protocol-expert`), docs (`docs-expert`), conformance, education.
- `seats.md` defines *when each seat is required* (Argus's delegation table and the
  triage expert matrix already encode most of this — unify them).

Dissent is recorded, not suppressed. A synthetic WG that always agrees is a Brian-clone
with extra steps; the value is in the memo saying "security seat objects, here's why,
chair recommends proceeding because X."

### 3. The memory — `governance/decisions/`

ADR-style decision records, one file per ruling:

```
governance/decisions/2026-07-xx-governance-context-echo.md
---
class: normative
outcome: rejected
principle: buyer→seller→governance forwarding is mandated; seller→buyer echo is not
refs: [#5719]
dissent: none
ratified_by: lazy-consensus (5-day window, no objection)
---
```

- Triage and Argus **cite precedent** in reviews (retrieval over the decisions dir).
- The weekly context-refresh routine indexes new records.
- This also closes the charter's minutes gap: Addie publishes a weekly digest of
  decision records to `governance/minutes/` — the "meeting" is asynchronous and
  continuous, and the minutes are generated, not transcribed.

Bootstrap: backfill ~10 exemplar records from known precedents (the #5719 rejection,
feed_format ownership, error-code enumMetadata dual-surface, capability-gate defaults,
BCP47 language convention, universal macro compliance scoping...). These exist in
memory and PR threads today; writing them down is the highest-leverage single act in
this whole proposal.

### 4. The secretary — Addie

Addie becomes the process owner. New capability in two layers:

**GitHub write tools** (currently missing): `comment_on_github_issue`,
`add_issue_labels`, `set_issue_milestone`. Same whitelist and PII rules as her
existing GitHub tools. She still never merges and never reviews PRs — Argus owns the
PR surface.

**A `wg-secretary` job family** (on her existing scheduler):

- **Decision-queue sweep** (daily): find issues/PRs with an open decision record and
  no movement; chase per state.
- **Info-request tracker**: when a panel review produces an information need ("will
  this break Triton's audio flows?"), Addie routes it to a *named person* — issue
  author first, then domain-relevant members chosen via her relationship model (WG
  membership, expertise, past contributions). Requests run through the engagement
  planner with its existing cooldowns (no spam), tracked like escalations with SLAs.
  Unanswered after N days → the panel decides with a recorded assumption, or defers.
  **This is the capability no GitHub bot can replicate and the heart of "guardian of
  the spec."**
- **Ballot runner**: for Normative+ decisions, open the async ballot per the charter
  (5-day window), notify voting reps (she knows who they are and their engagement
  stage), chase quorum, tally, record.
- **Weekly WG report**: decisions made (with links to records), decisions pending
  (with named blockers), info requests outstanding, release-train status. Posted to
  #wg-adcp and the WG digest (infrastructure exists).

### 5. Decision routing by class

Replaces triage's single "Flag → @bokelley" path:

| Class | Who decides | Mechanism |
|---|---|---|
| Editorial | Synthetic panel, autonomous | Argus/triage decides; decision record written; humans can appeal |
| Normative | Panel recommends → humans ratify | Decision memo posted; **5-day lazy consensus** (merges unless a voting member objects); objection converts to a real ballot |
| Breaking | Humans, always | Panel memo is input; charter ballot (¾, 7 quorum); Brian votes as a member |
| Constitutional / political / security-posture | Brian + Board | The short escalation list in the constitution |

Lazy consensus is the key throughput unlock: it uses the charter's existing async
ballot window but inverts the default, so silence means the staff recommendation
stands. The human WG retains full veto at zero standing cost.

## The 3.2 release train

Addie as release manager, using machinery that already exists (runbooks in
`.agents/shortcuts/cut-*.md`, changesets pre-mode, forward-merge workflows):

1. **Scope gate (run first, this month).** 102 open issues against Aug 31 is not a
   shippable scope. One-shot pass: panel classifies every 3.2.0 issue as
   *committed / at-risk / punt* (to Spec Backlog or 4.0) with a one-line rationale
   each, producing a scope memo for human ratification. This is the single biggest
   immediate Brian-time saving and doesn't require any new infrastructure — it can run
   as a workflow today.
2. **Weekly burndown** in the WG report: committed-scope progress, blocked items with
   names, decisions needed this week.
3. **RC criteria checklist**, maintained as a living decision record: schema audit
   green, conformance suite covers new tasks, docs snapshot ready, SDK matrix green,
   migration notes written.
4. **Beta cadence**: Addie proposes each `3.2.0-beta.N` cut when merged changesets
   warrant; go/no-go memos to Brian for RC and stable only.

Brian's mandatory touches for the whole release: ratify scope memo, RC go/no-go,
stable go/no-go. Three decisions.

## Graduated autonomy and measurement

Do not flip a switch. Track every synthetic decision against its eventual human
outcome:

- **Overturn rate per class** = decisions later reversed by a human / total. Editorial
  autonomy is already de facto (Argus approves ~85% of PRs). Normative lazy-consensus
  starts *shadow-mode*: memos posted, but Brian ratifies manually for 4 weeks; if
  overturn <5%, flip to true lazy consensus.
- **KPIs on the weekly report**: median time-to-decision, Brian-touches per week
  (target: trending to ~3/week), info-request response rate, decision-record coverage
  (% of merged Normative+ changes with a record).
- **Adversarial verification stays**: any blocking finding or Breaking classification
  gets an independent refutation pass before posting (the trust-but-verify lesson —
  Argus has produced plausible-but-wrong findings).

## What Brian's job becomes

1. Amend the constitution (via PR, like anyone — but in practice, this is where his
   judgment compounds: every correction becomes a permanent principle instead of a
   one-off review comment).
2. Vote on Breaking-class changes and appeals, as one voting member among several.
3. Go/no-go on releases.
4. The genuinely political: member disputes, recusal cases, security posture,
   anything on the constitution's escalation list.

Everything else arrives as a weekly memo he can skim.

## Risks and posture

- **Legitimacy with the human WG.** Framing matters: this is the WG's *secretariat*,
  not its replacement. Members gain (faster decisions, real minutes, precedent they
  can cite) and lose nothing (full veto via objection). Announce it as staffing the
  charter that already exists.
- **IPR/antitrust.** Normative+ decisions carry human ratification by design (lazy
  consensus is still member consent — the objection right is real and low-friction).
  Decision records create the audit trail a standards org should have anyway.
- **Prompt injection.** The constitution and seats live under `.agents/*` — already
  sensitive-path gated; Argus already loads prompts from base SHA. Addie's new GitHub
  write tools need the same posture as her existing ones (whitelist, PII rules, no
  merge/review capability).
- **Personification (decided 2026-07-03).** The institution is the **AAO
  Secretariat**. On GitHub, all desks (Argus reviews, triage comments, secretary
  process posts) write under a Secretariat bot identity — either a new GitHub App
  named "AAO Secretariat" (preferred: keeps release machinery and review trust
  surfaces separate) or a rename of `aao-release-bot`. Creating/renaming the App
  and swapping workflow secrets (a new App-ID/private-key pair, plus
  `ARGUS_BOT_LOGIN` in `ai-review.yml`) is an org-admin action for Brian. On human
  surfaces (Slack, email, digests) the secretariat function is personified — Addie
  wearing the secretary hat in a terse procedural register, or a distinct
  character à la Sage if the WG prefers; that choice is cosmetic and swappable at
  Stage 3, the bot identity is not.

## Implementation plan

**Stage 1 — Constitution + decision log** (no behavior change, ~1–2 weeks)
Extract constitution from Argus prompt + triage prompt + playbook. Create
`governance/decisions/` with ~10 backfilled exemplar records. Argus and triage prompts
start citing the constitution and writing a decision record on every Flag-class
outcome. **Also run the 3.2 scope-gate pass now as a one-off** — it needs nothing from
later stages.

**Stage 2 — Unify the brain** (~2–3 weeks)
Refactor Argus + triage to consume constitution/seats/precedents. Retire "voice of
Brian." Triage's Flag outcome becomes classify-by-decision-class; only
Breaking/political pings @bokelley directly. Normative memos run shadow-mode
ratification.

**Stage 3 — Addie as secretary** (~3–4 weeks)
GitHub write tools; `wg-secretary` job family (decision-queue sweep, info-request
tracker, ballot runner, weekly report). Info-request routing through the relationship
model. Minutes generation to `governance/minutes/`.

**Stage 4 — 3.2 release train** (immediately once Stage 3 lands)
Weekly burndown, RC checklist, beta cadence proposals, go/no-go memos.

**Stage 5 — Graduated autonomy** (ongoing)
Overturn-rate dashboard; flip Normative to true lazy consensus when earned; revisit
Editorial-class scope quarterly.

## Implementation status

- **Stage 1 (2026-07-03):** `.agents/wg/constitution.md` + `.agents/wg/seats.md`
  created; `governance/decisions/` created with DR-0001–DR-0009 backfilled;
  Argus prompt re-grounded on the constitution (persona clause retired,
  precedent + decision-class rules added, constitution injected from base SHA
  via `ai-review.yml`); triage Flag outcome now routes by decision class
  (Normative → decision memo + `needs-wg-review`, no maintainer ping;
  Breaking/security/disputed → @bokelley).
- Remaining for Brian (ops): create the "AAO Secretariat" GitHub App (or rename
  `aao-release-bot`), swap workflow secrets, update `ARGUS_BOT_LOGIN`.
- Next: Stage 2 shadow-mode Normative ratification; 3.2 scope-gate pass;
  Stage 3 secretary tools in Addie.

## Open questions

1. **Who fronts GitHub?** ~~Addie-branded secretary comments vs. keeping all
   GitHub output under Argus/`aao-release-bot`~~ — **decided**, see
   Personification under Risks.
2. **Voting-rep enrollment.** Lazy consensus needs a real roster of voting reps with
   working notification channels — is the charter's enrollment current enough, or is
   fixing that a prerequisite?
3. **Where does the panel run for issue-scale work?** Triage routine (cloud, per-issue)
   is fine for singles; the 3.2 scope pass wants a batch workflow. Probably both, per
   surface.
4. **Does the constitution live in `.agents/wg/` or `governance/`?** Governance is more
   honest (it's a WG document, human-ratified); `.agents/` gets the sensitive-path
   gate for free. Could split: principles in `governance/`, machine operating rules in
   `.agents/wg/`.
