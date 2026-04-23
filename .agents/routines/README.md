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

   - **Name:** `adcp — issue triage` (adjust per repo)
   - **Prompt:** paste from `triage-prompt.md`, prefixed with the three
     files to read (see that doc)
   - **Repository:** the target repo; leave branch pushes restricted to
     `claude/*`
   - **Environment:** new env, paste `environment-setup.sh` into the setup
     script field; Trusted network access
   - **Schedule trigger:** daily or every 6h (up to you)

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

5. *(Optional)* **GitHub trigger** *(web only)* — add a `pull_request`
   trigger filtered to `head branch starts-with claude/` so the routine
   also responds to its own PRs' CI/review events. Or skip this and use
   auto-fix (toggle per-PR) instead.

## Auto-fix

Separate feature, not a routine. On any PR Claude opens, hit **Auto-fix**
in the CI status bar or run `/autofix-pr` locally while on the branch.
Claude then watches that PR for CI failures and review comments and
pushes fixes. Requires the Claude GitHub App (already installed above).

## Usage and cost

Routines draw from the same subscription pool as interactive sessions,
plus a daily per-account run cap. See
[claude.ai/settings/usage](https://claude.ai/settings/usage). Enable
extra usage in billing if you want metered overage when the cap hits.
