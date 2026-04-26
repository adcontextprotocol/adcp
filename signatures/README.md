# IPR Signatures

This directory holds the canonical ledger of contributors who have agreed to the
[IPR Policy](../IPR_POLICY.md).

## The ledger

- File: [`ipr-signatures.json`](./ipr-signatures.json)
- Scope: one ledger covers all AgenticAdvertising.Org repositories
  (`adcontextprotocol/adcp`, `adcontextprotocol/adcp-client`,
  `adcontextprotocol/adcp-client-python`, `adcontextprotocol/adcp-go`,
  `adcontextprotocol/creative-agent`, `prebid/salesagent`). A contributor signs once
  and is recognized across all of them.
- Each entry records the signing GitHub user, the `created_at` timestamp of the
  signing comment, and its origin PR.

## How a contributor signs

1. Open a pull request in any AAO repository that uses this check.
2. The workflow posts a comment requesting agreement to the IPR Policy.
3. Post a new comment on the PR with the exact phrase:

   ```
   I have read the IPR Policy
   ```

4. The workflow verifies the commenter is the PR author, appends a new entry to
   `ipr-signatures.json` on `main`, and marks the `IPR Policy / Signature`
   commit status as success.

Only the PR author's signature is required. A signature applies to all future
contributions from the same GitHub user across AAO repositories.

## What we fixed (April 2026)

The earlier workflow used `contributor-assistant/github-action`, which validated
**commit-author emails** and silently refused to record signatures when a
commit's `git config user.email` didn't resolve to a registered GitHub user —
even when the PR author was a valid GitHub user who commented the sign phrase.
Several contributors (including @mikulbhatt, @tdgonzales-boosted-to-11,
@lclaudon, @kmoegling-scope3, @numarasSigmaSoftware, @damianbedrock,
@benjaminclot, @thejamesbox) signed correctly but were never recorded.

The current workflow ([.github/workflows/ipr-agreement.yml](../.github/workflows/ipr-agreement.yml))
validates the **commenter's GitHub identity** against the PR author, matching
what the IPR Policy actually binds: a Contributor (a person), not a git
identity. Historical signatures were backfilled via
[`scripts/ipr/backfill.mjs`](../scripts/ipr/backfill.mjs).

## Operating the ledger

### Re-run the backfill

```bash
GITHUB_TOKEN=$(gh auth token) node scripts/ipr/backfill.mjs           # dry-run
GITHUB_TOKEN=$(gh auth token) node scripts/ipr/backfill.mjs --write   # update file
```

Review the diff and commit manually. The script is idempotent: it will not
duplicate signatures for a GitHub user already present in the ledger.

### Add a manual entry

For entries that didn't come through a PR comment (e.g., Working Group
consensus, recorded in minutes), edit `ipr-signatures.json` directly and use:

```json
{
  "name": "<github-login>",
  "id": <github-user-id>,
  "created_at": "<iso8601>",
  "method": "manual",
  "notes": "<short provenance, e.g. WG minutes 2026-04-23>"
}
```

## Adopting in a new repository

Copy [`scripts/ipr/`](../scripts/ipr/) and
[`.github/workflows/ipr-agreement.yml`](../.github/workflows/ipr-agreement.yml)
into the new repo. Each repo currently keeps its own local ledger; a central
cross-repo ledger (writing all signatures into `adcontextprotocol/adcp` from any
repo's workflow) requires a GitHub App with `contents:write` on the central
repo, installed on each downstream repo, with its credentials stored as secrets.
That consolidation is a follow-up — tracked separately.

## Caveats

- **Branch protection and the workflow**: this workflow pushes signature
  updates directly to `main`. If `main` gets branch protection requiring pull
  requests, the workflow will need an exempted bot identity (GitHub App) or a
  different storage model (e.g., a `signatures` branch that syncs back via a
  scheduled job).
- **PRs modifying the ledger**: pull requests should not modify
  `signatures/ipr-signatures.json`. The file is machine-managed; hand edits
  belong in separate, reviewed commits.
