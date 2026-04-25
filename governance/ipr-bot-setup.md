# AAO IPR Bot — GitHub App setup

The IPR signature workflow exists in two forms:

- **Local**: `adcontextprotocol/adcp` writes to its own `signatures/ipr-signatures.json` using the default `GITHUB_TOKEN`. No App needed for adcp itself.
- **Cross-repo**: every other AAO repository (`adcp-client`, `adcp-client-python`, `adcp-go`, `creative-agent`) writes signatures back to the central ledger in adcp via a GitHub App installation token.

This document describes how the App is configured and what to do when it needs to be rotated, replaced, or scoped.

## App configuration

| Field | Value |
|---|---|
| Name | `AAO IPR Bot` |
| Owner | `adcontextprotocol` (organization) |
| Homepage URL | `https://agenticadvertising.org/governance/ipr` |
| Webhooks | Disabled |
| Identifying / authorizing users | All defaults; no user OAuth flow |

### Repository permissions

| Permission | Level | Why |
|---|---|---|
| Contents | Read & write | Read for checkout, write to commit signature updates to adcp |
| Pull requests | Write | Post the request/confirmation comments |
| Commit statuses | Write | Set the `IPR Policy / Signature` check |
| Metadata | Read | Mandatory; always granted |

No organization permissions are needed.

### Installation scope

Install on these repos only:

- `adcontextprotocol/adcp`
- `adcontextprotocol/adcp-client`
- `adcontextprotocol/adcp-client-python`
- `adcontextprotocol/adcp-go`
- `adcontextprotocol/creative-agent`

`prebid/salesagent` lives in a different organization. If we want it covered, install a separate App in the `prebid` org or add the repo to a future cross-org strategy.

## Secrets

Two organization-level secrets are required, scoped to the same five repos:

| Secret | Source |
|---|---|
| `IPR_APP_ID` | App ID shown on the App's settings page (numeric) |
| `IPR_APP_PRIVATE_KEY` | Full contents of the `.pem` file generated when creating the App |

The `.pem` file should not be checked into any repo. After generation, paste its full contents (including the BEGIN/END lines) into the org-secret form and delete the local copy.

## How the workflows use the App

### `adcp` — local flow

`.github/workflows/ipr-agreement.yml` runs in adcp on PR + comment events. It checks out `main` with the default `GITHUB_TOKEN`, runs `scripts/ipr/check-and-record.mjs`, and commits + pushes signature updates back to adcp. No App involvement.

### Downstream — cross-repo flow

Each downstream repo has a tiny caller workflow (~15 lines) that invokes the reusable workflow at `adcontextprotocol/adcp/.github/workflows/ipr-check-callable.yml@main`. The callable:

1. Mints an installation token via `actions/create-github-app-token@v2` scoped to `adcontextprotocol/adcp`.
2. Checks out `adcontextprotocol/adcp@main` into `.ipr-ledger/` using that token.
3. Runs `scripts/ipr/check-and-record.mjs` with `LEDGER_DIR=.ipr-ledger`. The script reads/writes signatures there; `git push` from inside the directory uses the installation token configured by the checkout step.
4. API calls back to the event repo (comments, status check) use the caller repo's default `GITHUB_TOKEN` — no cross-repo write required for those.

A repo-wide concurrency group (`adcp-ipr-signature-write`) serializes signature writes across all repos so two PRs can't race on the JSON file.

## Rotation

To rotate the private key without downtime:

1. Generate a new private key on the App's settings page (this leaves the old key valid until you delete it).
2. Update the `IPR_APP_PRIVATE_KEY` org secret with the new `.pem` contents.
3. Verify the next PR webhook in any downstream repo sets the `IPR Policy / Signature` status successfully.
4. Delete the old key from the App's settings page.

The App ID does not change during rotation.

## Revocation

If the App is compromised:

1. Delete the private key on the App's settings page (immediate revocation of any minted tokens within an hour).
2. Uninstall the App from all repositories (Settings → Integrations → Installed GitHub Apps → AAO IPR Bot → Configure → Uninstall).
3. Delete the `IPR_APP_ID` and `IPR_APP_PRIVATE_KEY` org secrets.
4. Investigate the audit log in the App's settings page for unexpected token use.

The signatures committed historically remain valid; only the future signing path is affected.

## Adoption checklist for a new downstream repo

1. Confirm the repo is in the App's installation scope (org settings → Installed GitHub Apps → AAO IPR Bot → Configure).
2. Confirm `IPR_APP_ID` and `IPR_APP_PRIVATE_KEY` org secrets are accessible to that repo (they should be by default if scoped to the org or to that specific repo).
3. Add this caller workflow at `.github/workflows/ipr-agreement.yml` in the new repo:

   ```yaml
   name: IPR Agreement
   on:
     issue_comment:
       types: [created]
     pull_request_target:
       types: [opened, synchronize, reopened]
   permissions:
     pull-requests: write
     statuses: write
   jobs:
     check:
       uses: adcontextprotocol/adcp/.github/workflows/ipr-check-callable.yml@main
       secrets:
         IPR_APP_ID: ${{ secrets.IPR_APP_ID }}
         IPR_APP_PRIVATE_KEY: ${{ secrets.IPR_APP_PRIVATE_KEY }}
   ```

4. Open a test PR from a fresh fork or unsigned account to verify the full path: comment fires, signature lands in `adcp@main:signatures/ipr-signatures.json`, status check goes green.
