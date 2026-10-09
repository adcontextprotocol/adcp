# Claude Code Routines

Routines put Claude Code on autopilot against this repo. They run on
Anthropic-managed cloud infrastructure (laptop closed = still running) at
[claude.ai/code/routines](https://claude.ai/code/routines).

This directory holds the committed half of each routine: prompts, setup
scripts, and context. The saved configuration at claude.ai is kept thin and
points back at these files, so iteration happens in the repo.

## What's here

| File | Purpose |
|---|---|
| `triage-prompt.md` | Instructions for the issue-triage routine |
| `context-refresh-prompt.md` | Instructions for the weekly context-snapshot routine |
| `environment-setup.sh` | Setup script to paste into the routine's cloud environment |
| `../current-context.md` | Roadmap/priorities snapshot, regenerated weekly |

## Status — launchers manually disabled; triage is routing-only

The live GitHub launchers (`.github/workflows/claude-issue-triage.yml` and
`.github/workflows/triage-webhook-miss-sweep.yml`) have been **manually
disabled** outside this repository's source. The external Claude routine
can have an independent scheduled trigger; this workspace cannot verify or
pause that trigger. Pause any such schedule in the routine's Claude UI
until this policy has merged and the saved launcher has been verified.
Disabling is a manual operational state; nothing
in this repo re-enables it automatically, and this README does not claim
the routing-only policy is live until the policy PR is merged.

Policy in `triage-prompt.md`: triage provides routing, clarification,
duplicate/owner detection, and implementation briefs **only**. It never
creates branches, edits implementation code, opens or updates PRs, or
pushes commits. `/triage execute` remains as backward-compatible intake and
yields a Ready-to-implement brief (or the relevant defer/flag outcome);
PR-feedback mode is read/respond only. Because the launcher reads the
current prompt on every run, the repository policy covers scheduled,
manual, and event runs after merge. The saved launcher is separate
configuration: replace it with the routing-only launcher below in the
routine's Claude UI and verify it contains no stale execution instructions
before considering the rollout complete.

**Re-enable the launchers only after** (1) this policy has merged,
(2) the saved Claude launcher has been replaced and verified as above, and
(3) an accountable implementation / review / CI / human-merge path exists
for acting on briefs. Re-enabling is a deliberate manual step.

## Identity — read this first

Routines are owned by whichever claude.ai account **created** them. That
account's subscription is what burns tokens on every run, and its linked
GitHub identity is what commits appear as. For this project we want
`brian@agenticadvertising.org`.

Before creating any routine:

1. In your Claude Code CLI, run `/status`. Confirm you're signed in as
   `brian@agenticadvertising.org`. If not, `/login`.
2. Run `/web-setup` in that session to sync GitHub auth to the account.
3. Install the [Claude GitHub App](https://github.com/apps/claude) on
   `adcontextprotocol/adcp`, `adcp-client`, and `adcp-client-python`.
   Authorize under the GitHub identity you want commits to appear as.

The per-routine bearer tokens generated later are scoped to their routine,
so the billing account is baked in at creation time — the bridge workflow
doesn't need to know anything about identity.

## Setup order (per repo)

Do these in order. Steps marked *(web)* require the claude.ai UI.

1. **Create the routine** *(web or CLI)* — at
   [claude.ai/code/routines](https://claude.ai/code/routines), **New
   routine**. Or run `/schedule daily at 9am` in the CLI and walk the
   prompts.

   - **Name:** `adcp — issue triage`
   - **Prompt:** the minimal launcher below — **do not** paste the full
     `triage-prompt.md`. The launcher points at the file in the repo so
     edits to `triage-prompt.md` flow to the live routine on the next
     fire without any re-paste.
   - **Repository:** `adcontextprotocol/adcp`; triage does not push
     branches, so leave branch pushes restricted (or disabled)
   - **Environment:** new env, paste `environment-setup.sh` into the setup
     script field; Trusted network access
   - **Schedule trigger:** daily or every 6h (up to you)

   Launcher prompt (paste verbatim — this is what's deployed):

   ```
   You are the adcp issue-triage agent for adcontextprotocol/adcp.

   Read .agents/routines/triage-prompt.md and follow it exactly. That
   file is your primary behavior guide — CLAUDE.md,
   .agents/playbook.md, and .agents/current-context.md are supporting
   context the triage prompt will tell you when to read. Expert
   subagents live at .claude/agents/*.md and are spawned via the Task
   tool per the workflow in triage-prompt.md.

   If .agents/routines/triage-prompt.md does not exist, stop and
   report. If .claude/agents/ is missing, the v2 expert-consultation
   PR has not merged — also stop and report.

   Run type:
   • EVENT-DRIVEN: if this conversation contains issue context from
     /fire (event name, repo, issue number, body fenced as
     UNTRUSTED_ISSUE_BODY), act on that single issue.
   • SCHEDULED: otherwise, walk open issues without the
     `claude-triaged` label, skipping bot authors and issues with no
     activity in 90+ days. Cap at 10 per run.

   You are routing-only: never create branches, edit code, open or
   update PRs, or push commits. Token budget burns
   brian@agenticadvertising.org's account. Output a run summary at
   the end.
   ```

2. **Add an API trigger** *(web only)* — on the routine's edit page,
   **Add another trigger → API**. Copy the URL, click **Generate token**,
   copy the token immediately (shown once).

3. **Add repo secrets** — in the target repo's GitHub settings:

   ```
   CLAUDE_ROUTINE_TRIAGE_URL   = <URL from step 2>
   CLAUDE_ROUTINE_TRIAGE_TOKEN = <token from step 2>
   ```

4. **Bridge workflow already committed** at
   `.github/workflows/claude-issue-triage.yml`. On `issues.opened` it POSTs
   the issue body to the routine's `/fire` endpoint so the routine reacts
   within minutes instead of waiting for the next scheduled run.

5. Do **not** add a GitHub `pull_request` trigger or any other path that
   would have the routine push to PRs; triage is read/respond only there.

## Auto-fix

Auto-fix is a separate Claude Code feature, not part of this routine, and
is outside the triage policy. Triage never pushes fixes to a PR.

## Usage and cost

Routines draw from the same subscription pool as interactive sessions,
plus a daily per-account run cap. See
[claude.ai/settings/usage](https://claude.ai/settings/usage). Enable
extra usage in billing if you want metered overage when the cap hits.
