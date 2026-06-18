# Prep Empty

Historical shortcut name. Use this when the change is not a protocol/spec
release change and should be prepared without a package changeset.

Default policy: non-protocol work gets **no** `.changeset/*.md` file. Do not add
empty changesets for app, site, billing, admin, Addie, newsletter, digest,
infra, migration, or operational-only work. Empty changesets are reserved for
explicit release-manager exceptions around release machinery.

## Workflow

1. Remove any stray non-protocol changeset files.
2. If the change includes UI work, test it in a browser:
   - **Vibium** (preferred for quick checks): `vibium go <url>`, `vibium map`,
     `vibium click "Button text"`, `vibium type "field" "value"`, `vibium screenshot`
   - **Playwright** (for scripted flows): use the `/playwright-skill` skill
3. Run `node scripts/check-changeset-protocol-scope.cjs origin/main` and confirm
   no protocol changeset is present.
4. Run code review and address the suggestions.
5. Prepare the PR.
6. **Check CodeQL comments on the PR** — run `gh api repos/adcontextprotocol/adcp/pulls/{PR_NUMBER}/comments` and fix any CodeQL findings before merge.

## Output Shape

Keep the response operational and concise. Call out anything still blocking the
PR.
