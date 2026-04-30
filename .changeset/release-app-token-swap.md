---
---

Swap the release pipeline workflows from `GITHUB_TOKEN` to a dedicated GitHub App installation token (`RELEASE_APP_ID` / `RELEASE_APP_PRIVATE_KEY`) so events triggered by these workflows fire downstream CI:

- **`release.yml`** — `changesets/action@v1` and `actions/checkout@v6` now use the App token. The Version Packages PR's push events fire required CI workflows (TypeScript Build, IPR Policy, Check for changeset). The post-merge `release: published` event also fires `release-docs.yml`.
- **`release-docs.yml`** — `actions/checkout@v6`, `peter-evans/create-pull-request@v8`, and `gh pr merge --auto` now use the App token. The auto-snapshot PR's open/sync events fire required CI; auto-merge proceeds without admin override.
- **`forward-merge-3.0.yml`** — `actions/checkout@v6` and `peter-evans/create-pull-request@v8` now use the App token. Forward-merge PRs fire required CI on open.

Closes #3417. Removes the friction notes from `.agents/playbook.md`, `.agents/shortcuts/cut-patch.md`, `.agents/shortcuts/cut-beta.md` since the workarounds (push from a human identity, manual workflow_dispatch, admin-merge) are no longer needed.

**Required before merge:** create a GitHub App in the org with `contents: write`, `pull-requests: write`, `issues: write`, `workflows: write`, `metadata: read` permissions, install it on `adcontextprotocol/adcp`, and store the `APP_ID` and `PRIVATE_KEY` as repo secrets `RELEASE_APP_ID` and `RELEASE_APP_PRIVATE_KEY`. Without these secrets, all three workflows will fail at the `Mint AAO Release Bot installation token` step.
